import type { Exec } from "../../ports/exec.js";
import type { LidPort, LidSnapshot } from "../../ports/lid.js";
import { encodedCommandArgs, psQuote } from "./powershell.js";

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEX_INDEX = /^0x[0-9a-f]{8}$/i;

type WinLid = Extract<LidSnapshot, { kind: "win32" }>;

/** Scheme GUID from `powercfg /getactivescheme`; the surrounding label is localized. */
export function parseActiveScheme(text: string): string | null {
  return GUID.exec(text)?.[0] ?? null;
}

/**
 * Last two 0x........ values in `powercfg /query` are the AC then DC index.
 * Labels are localized, so we never match on them. "Possible Setting Index"
 * lines use short decimals and do not collide with the 8-digit hex form.
 */
export function parseLidIndexes(text: string): { ac: string; dc: string } | null {
  const hits = text.match(/0x[0-9a-f]{8}/gi);
  if (!hits || hits.length < 2) return null;
  return { ac: hits[hits.length - 2]!.toLowerCase(), dc: hits[hits.length - 1]!.toLowerCase() };
}

function setCommands(scheme: string, ac: string, dc: string): string[][] {
  // powercfg takes decimal; the snapshot keeps the hex it printed.
  const n = (hex: string) => String(parseInt(hex, 16));
  return [
    ["/setacvalueindex", scheme, "SUB_BUTTONS", "LIDACTION", n(ac)],
    ["/setdcvalueindex", scheme, "SUB_BUTTONS", "LIDACTION", n(dc)],
    ["/setactive", scheme],
  ];
}

export function createWin32Lid(exec: Exec): LidPort {
  async function runAll(cmds: string[][]): Promise<boolean> {
    for (const c of cmds) {
      const r = await exec.run("powercfg", c, { timeoutMs: 10000 });
      if (r.code !== 0) return false;
    }
    return true;
  }

  // One UAC prompt for the whole batch. -PassThru is needed because
  // Start-Process -Wait alone drops the child's exit code.
  async function runElevated(cmds: string[][]): Promise<boolean> {
    const inner = [
      ...cmds.map((c) => `powercfg ${c.map(psQuote).join(" ")}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`),
      "exit 0",
    ].join("\n");
    const innerArgs = encodedCommandArgs(inner);
    // A refused UAC prompt makes Start-Process throw; without Stop + catch the script would
    // fall through to `exit $p.ExitCode` with $p null, which exits 0 and looks like success.
    const outer = [
      "$ErrorActionPreference = 'Stop'",
      "try {",
      `  $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${innerArgs
        .map(psQuote)
        .join(",")}`,
      "  if ($null -eq $p) { exit 1 }",
      "  exit $p.ExitCode",
      "} catch { exit 1223 }",
    ].join("\n");
    const r = await exec.run("powershell.exe", encodedCommandArgs(outer), { timeoutMs: 120000 });
    return r.code === 0;
  }

  async function change(cmds: string[][]): Promise<void> {
    if (await runAll(cmds)) return;
    if (!(await runElevated(cmds))) throw new Error("could not change the lid close action (UAC refused or powercfg failed)");
  }

  return {
    async snapshot(): Promise<WinLid> {
      const active = await exec.run("powercfg", ["/getactivescheme"], { timeoutMs: 10000 });
      const scheme = parseActiveScheme(active.stdout);
      if (active.code !== 0 || !scheme) throw new Error("could not read the active power scheme");
      const q = await exec.run("powercfg", ["/query", scheme, "SUB_BUTTONS", "LIDACTION"], { timeoutMs: 10000 });
      const idx = parseLidIndexes(q.stdout);
      if (q.code !== 0 || !idx) throw new Error("could not read the lid close action");
      return { kind: "win32", scheme, ac: idx.ac, dc: idx.dc };
    },
    async set(snapshot: LidSnapshot): Promise<void> {
      if (snapshot.kind !== "win32") return;
      if (!GUID.test(snapshot.scheme)) throw new Error("lid snapshot in state file is malformed");
      await change(setCommands(snapshot.scheme, "0x00000000", "0x00000000"));
    },
    async restore(snapshot: LidSnapshot): Promise<void> {
      if (snapshot.kind !== "win32") return;
      // The snapshot comes from state.json, so re-validate before it reaches a command line.
      if (!GUID.test(snapshot.scheme) || !HEX_INDEX.test(snapshot.ac) || !HEX_INDEX.test(snapshot.dc)) {
        throw new Error("lid snapshot in state file is malformed");
      }
      await change(setCommands(snapshot.scheme, snapshot.ac, snapshot.dc));
    },
  };
}
