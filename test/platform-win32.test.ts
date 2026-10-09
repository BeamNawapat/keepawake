import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS } from "../src/core/agents.js";
import { detectAgents } from "../src/core/detector.js";
import { createWin32Autostart, buildStartVbs } from "../src/platform/win32/autostart.js";
import { isAliveWin32, queryWin32Process } from "../src/platform/win32/alive.js";
import { createWin32Lid, parseActiveScheme, parseLidIndexes } from "../src/platform/win32/lid.js";
import { createWin32Network, parseCurrentSsid } from "../src/platform/win32/network.js";
import { createWin32Power, holderScript, type HolderChild } from "../src/platform/win32/power.js";
import { encodedCommandArgs, psQuote } from "../src/platform/win32/powershell.js";
import { createWin32Privilege } from "../src/platform/win32/privilege.js";
import { createWin32ProcessLister, parseWin32Processes } from "../src/platform/win32/processes.js";
import { fakeExec } from "./fake-exec.js";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf16le");
/** Answers the CIM lookup (the only powershell.exe call these code paths make) with one row, or nothing. */
function withCim(exec: ReturnType<typeof fakeExec>, row: { Name: string; CommandLine: string } | null) {
  const inner = exec.run.bind(exec);
  exec.run = async (cmd, args, o) => {
    if (cmd !== "powershell.exe") return inner(cmd, args, o);
    exec.calls.push("powershell.exe <cim>");
    return { code: 0, stdout: row ? JSON.stringify(row) : "", stderr: "" };
  };
  return exec;
}
const holderCmd = (display = false) =>
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommandArgs(holderScript(display)).at(-1)}`;
const GUID = "381b4222-f694-41f0-9685-ff5bb260df2e";

describe("powershell helpers", () => {
  test("EncodedCommand round-trips UTF-16LE", () => {
    const args = encodedCommandArgs("Write-Output 'สวัสดี'");
    expect(args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(decode(args[5]!)).toBe("Write-Output 'สวัสดี'");
  });
  test("psQuote doubles single quotes", () => {
    expect(psQuote("a'; calc; '")).toBe("'a''; calc; '''");
  });
});

describe("power holder", () => {
  test("script sets decimal flags, with and without display", () => {
    expect(holderScript(false)).toContain("SetThreadExecutionState(2147483649)");
    expect(holderScript(true)).toContain("SetThreadExecutionState(2147483651)");
    expect(holderScript(false)).toContain("[Console]::In.ReadLine()");
  });

  function fakeChild(pid: number | undefined) {
    const child = new EventEmitter() as HolderChild & { ended: boolean };
    child.pid = pid;
    child.ended = false;
    child.stdin = { end: () => void (child.ended = true) };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }

  test("acquire spawns hidden powershell; release closes stdin, verifies, then taskkill", async () => {
    const exec = withCim(fakeExec({ "taskkill /PID 777 /T /F": "ok" }), { Name: "powershell.exe", CommandLine: holderCmd(true) });
    let spawned: { cmd: string; args: string[] } | undefined;
    const child = fakeChild(777);
    const power = createWin32Power(exec, (cmd, args) => ((spawned = { cmd, args }), child));
    const holder = await power.acquire({ display: true, ownerPid: 1 });
    expect(holder).toEqual({ pid: 777 });
    expect(spawned!.cmd).toBe("powershell.exe");
    expect(decode(spawned!.args.at(-1)!)).toContain("2147483651");
    expect(await power.release({ pid: 777, ownerPid: 1 })).toBe(true);
    expect(child.ended).toBe(true);
    expect(exec.calls).toEqual(["powershell.exe <cim>", "taskkill /PID 777 /T /F"]);
  });

  test("release skips taskkill for a reused pid, a foreign powershell and a vanished pid", async () => {
    const reused = withCim(fakeExec(), { Name: "chrome.exe", CommandLine: "chrome.exe --type=gpu" });
    expect(await createWin32Power(reused).release({ pid: 777, ownerPid: 1 })).toBe(false);
    const foreign = withCim(fakeExec(), { Name: "powershell.exe", CommandLine: "powershell.exe -EncodedCommand AAAA" });
    expect(await createWin32Power(foreign).release({ pid: 777, ownerPid: 1 })).toBe(false);
    const gone = withCim(fakeExec(), null);
    expect(await createWin32Power(gone).release({ pid: 777, ownerPid: 1 })).toBe(false);
    for (const e of [reused, foreign, gone]) expect(e.calls.some((c) => c.startsWith("taskkill"))).toBe(false);
  });

  test("acquire rejects when spawn errors", async () => {
    const child = new EventEmitter() as HolderChild;
    child.stdin = null;
    queueMicrotask(() => child.emit("error", new Error("ENOENT")));
    const power = createWin32Power(fakeExec(), () => child);
    await expect(power.acquire({ display: false, ownerPid: 1 })).rejects.toThrow("ENOENT");
  });

  test("acquire rejects when no pid", async () => {
    const power = createWin32Power(fakeExec(), () => fakeChild(undefined));
    await expect(power.acquire({ display: false, ownerPid: 1 })).rejects.toThrow("pid");
  });
});

describe("lid", () => {
  test("parse English and Thai output", () => {
    for (const f of ["powercfg-lid-en.txt", "powercfg-lid-th.txt"]) {
      expect(parseActiveScheme(fx(f))).toBe(GUID);
    }
    expect(parseLidIndexes(fx("powercfg-lid-en.txt"))).toEqual({ ac: "0x00000001", dc: "0x00000002" });
    expect(parseLidIndexes(fx("powercfg-lid-th.txt"))).toEqual({ ac: "0x00000001", dc: "0x00000001" });
    expect(parseLidIndexes("nothing here")).toBeNull();
  });

  const query = `powercfg /query ${GUID} SUB_BUTTONS LIDACTION`;
  const sets = [
    `powercfg /setacvalueindex ${GUID} SUB_BUTTONS LIDACTION 0`,
    `powercfg /setdcvalueindex ${GUID} SUB_BUTTONS LIDACTION 0`,
    `powercfg /setactive ${GUID}`,
  ];

  test("snapshot reads without writing; set then makes three powercfg writes, no UAC", async () => {
    const exec = fakeExec({
      "powercfg /getactivescheme": fx("powercfg-lid-th.txt"),
      [query]: fx("powercfg-lid-en.txt"),
      ...Object.fromEntries(sets.map((s) => [s, "ok"])),
    });
    const lid = createWin32Lid(exec);
    const snap = await lid.snapshot();
    expect(snap).toEqual({ kind: "win32", scheme: GUID, ac: "0x00000001", dc: "0x00000002" });
    expect(exec.calls).toEqual(["powercfg /getactivescheme", query]);
    await lid.set(snap);
    expect(exec.calls).toEqual(["powercfg /getactivescheme", query, ...sets]);
  });

  test("set falls back to ONE RunAs call when powercfg is denied", async () => {
    let elevated: string[] | undefined;
    const exec = fakeExec({
      "powercfg /getactivescheme": fx("powercfg-lid-en.txt"),
      [query]: fx("powercfg-lid-en.txt"),
      [sets[0]!]: { code: 1 },
    });
    const inner = exec.run.bind(exec);
    exec.run = async (cmd, args, o) => {
      if (cmd === "powershell.exe") {
        elevated = args;
        exec.calls.push("powershell.exe <elevated>");
        return { code: 0, stdout: "", stderr: "" };
      }
      return inner(cmd, args, o);
    };
    await createWin32Lid(exec).set({ kind: "win32", scheme: GUID, ac: "0x00000001", dc: "0x00000002" });
    expect(exec.calls.filter((c) => c.startsWith("powershell.exe"))).toHaveLength(1);
    const outer = decode(elevated!.at(-1)!);
    expect(outer).toContain("Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden");
    expect(outer).toContain("$ErrorActionPreference = 'Stop'");
    expect(outer).toContain("try {");
    expect(outer).toContain("if ($null -eq $p) { exit 1 }");
    expect(outer).toContain("exit $p.ExitCode");
    expect(outer).toContain("} catch { exit 1223 }");
    // The batch is itself an EncodedCommand carrying all three writes.
    const innerB64 = /'([A-Za-z0-9+/=]{20,})'/.exec(outer)![1]!;
    const innerScript = decode(innerB64);
    expect(innerScript).toContain(`powercfg '/setacvalueindex' '${GUID}' 'SUB_BUTTONS' 'LIDACTION' '0'`);
    expect(innerScript).toContain(`powercfg '/setactive' '${GUID}'`);
  });

  test("set throws when elevation also fails", async () => {
    const exec = fakeExec({
      "powercfg /getactivescheme": fx("powercfg-lid-en.txt"),
      [query]: fx("powercfg-lid-en.txt"),
      [sets[0]!]: { code: 1 },
    });
    const inner = exec.run.bind(exec);
    exec.run = async (cmd, args, o) =>
      cmd === "powershell.exe" ? { code: 1223, stdout: "", stderr: "" } : inner(cmd, args, o);
    await expect(
      createWin32Lid(exec).set({ kind: "win32", scheme: GUID, ac: "0x00000001", dc: "0x00000002" }),
    ).rejects.toThrow("UAC");
  });

  test("restore writes decimal of the snapshot hex", async () => {
    const exec = fakeExec({
      [`powercfg /setacvalueindex ${GUID} SUB_BUTTONS LIDACTION 1`]: "ok",
      [`powercfg /setdcvalueindex ${GUID} SUB_BUTTONS LIDACTION 2`]: "ok",
      [`powercfg /setactive ${GUID}`]: "ok",
    });
    await createWin32Lid(exec).restore({ kind: "win32", scheme: GUID, ac: "0x00000001", dc: "0x00000002" });
    expect(exec.calls).toHaveLength(3);
  });

  test("restore rejects a tampered snapshot before running anything", async () => {
    const exec = fakeExec();
    const bad = { kind: "win32" as const, scheme: "x'; calc; '", ac: "0x00000001", dc: "0x00000001" };
    await expect(createWin32Lid(exec).restore(bad)).rejects.toThrow("malformed");
    expect(exec.calls).toEqual([]);
  });
});

describe("process lister", () => {
  const rows = fx("win32-process.json");

  test("maps rows, lowercases comm, drops .exe, keeps exePath", () => {
    const list = parseWin32Processes(rows);
    expect(list.find((p) => p.pid === 1200)).toMatchObject({ comm: "claude", exePath: expect.stringContaining(".local") });
    expect(list.find((p) => p.pid === 4)).toEqual({ pid: 4, ppid: 0, comm: "system" });
  });

  test("single object instead of array", () => {
    const one = JSON.stringify({ ProcessId: 9, ParentProcessId: 1, Name: "node.exe", ExecutablePath: null, CommandLine: "node x" });
    expect(parseWin32Processes(one)).toEqual([{ pid: 9, ppid: 1, comm: "node", args: "node x" }]);
  });

  test("empty output gives empty list; BOM tolerated", () => {
    expect(parseWin32Processes("  \r\n")).toEqual([]);
    expect(parseWin32Processes("\uFEFF" + rows)).toHaveLength(4);
  });

  test("lister runs powershell and feeds the detector: CLI vs desktop split", async () => {
    const exec = fakeExec();
    exec.run = async (cmd) => {
      exec.calls.push(cmd);
      return { code: 0, stdout: rows, stderr: "" };
    };
    const procs = await createWin32ProcessLister(exec).list();
    const found = detectAgents(procs, AGENTS, { platform: "win32", includeApps: true });
    const ids = found.map((d) => d.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("claude-desktop");
    expect(found.find((d) => d.id === "claude-code")!.pids).toEqual([1200]);
    expect(found.find((d) => d.id === "claude-desktop")!.pids).toEqual([3400]);
  });

  test("nonzero exit throws", async () => {
    const exec = fakeExec();
    exec.run = async () => ({ code: 1, stdout: "", stderr: "x" });
    await expect(createWin32ProcessLister(exec).list()).rejects.toThrow("exit 1");
  });
});

describe("privilege", () => {
  test("isElevated follows net session exit code", async () => {
    expect(await createWin32Privilege(fakeExec({ "net session": "ok" })).isElevated()).toBe(true);
    expect(await createWin32Privilege(fakeExec({ "net session": { code: 5 } })).isElevated()).toBe(false);
  });
});

describe("network", () => {
  test("connectWifi passes ssid as one arg, no shell", async () => {
    const exec = fakeExec({ "netsh wlan connect name=My Phone": "ok" });
    const net = createWin32Network(exec, async () => true);
    expect(await net.connectWifi("My Phone")).toBe(true);
  });

  test("connectWifi reports a failed netsh", async () => {
    const net = createWin32Network(fakeExec({ "netsh wlan connect name=X": { code: 1 } }), async () => true);
    expect(await net.connectWifi("X")).toBe(false);
  });

  test("ssid with quote or newline is refused without running netsh", async () => {
    const exec = fakeExec();
    const net = createWin32Network(exec, async () => true);
    expect(await net.connectWifi('a" & calc & "')).toBe(false);
    expect(await net.connectWifi("a\nb")).toBe(false);
    expect(exec.calls).toEqual([]);
  });

  test("current ssid ignores BSSID; null when absent", async () => {
    expect(parseCurrentSsid(fx("netsh-interfaces.txt"))).toBe("Beam's iPhone");
    expect(parseCurrentSsid("There is 1 interface\n    BSSID : aa:bb")).toBeNull();
    const net = createWin32Network(fakeExec({ "netsh wlan show interfaces": fx("netsh-interfaces.txt") }), async () => true);
    expect(await net.currentSsid()).toBe("Beam's iPhone");
  });

  test("isOnline falls back to the second host", async () => {
    const seen: string[] = [];
    const net = createWin32Network(fakeExec(), async (h) => (seen.push(h), h === "8.8.8.8"));
    expect(await net.isOnline()).toBe(true);
    expect(seen).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(await createWin32Network(fakeExec(), async () => false).isOnline()).toBe(false);
  });
});

describe("autostart", () => {
  const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

  test("vbs quotes each arg and doubles quotes for VBScript", () => {
    const vbs = buildStartVbs(["C:\\Program Files\\nodejs\\node.exe", "C:\\x\\cli.js", "start", "--always"]);
    expect(vbs).toContain('sh.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\x\\cli.js"" ""start"" ""--always""", 0, False');
    expect(() => buildStartVbs(['a"b'])).toThrow("double quotes");
  });

  test("install writes start.vbs and the Run key; remove deletes both", async () => {
    const appData = mkdtempSync(join(tmpdir(), "ka-"));
    const path = join(appData, "keepawake", "start.vbs");
    const exec = fakeExec({
      [`reg add ${KEY} /v keepawake /t REG_SZ /d wscript.exe "${path}" /f`]: "ok",
      [`reg query ${KEY} /v keepawake`]: "ok",
      [`reg delete ${KEY} /v keepawake /f`]: "ok",
    });
    const auto = createWin32Autostart(exec, { appData });
    expect(await auto.install(["node.exe", "cli.js", "start"])).toEqual({ path });
    expect(existsSync(path)).toBe(true);
    // WSH needs the UTF-16LE BOM to read non-ASCII paths.
    const raw = readFileSync(path);
    expect([raw[0], raw[1]]).toEqual([0xff, 0xfe]);
    expect(raw.subarray(2).toString("utf16le")).toContain("sh.Run");
    expect(await auto.isInstalled()).toBe(true);
    expect(await auto.remove()).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("isInstalled false when the value is missing", async () => {
    const auto = createWin32Autostart(fakeExec({ [`reg query ${KEY} /v keepawake`]: { code: 1 } }), { appData: tmpdir() });
    expect(await auto.isInstalled()).toBe(false);
  });
});

describe("isAliveWin32", () => {
  const key = (pid: number) => `tasklist /FI PID eq ${pid} /FO CSV /NH`;
  const CLI = "C:\\x\\keepawake\\dist\\cli.js";
  const daemon = { mode: "daemon" as const, cli: CLI };
  const fg = { mode: "foreground" as const, cli: CLI };
  const node42 = { [key(42)]: '"node.exe","42","Console","1","40,000 K"\r\n' };

  test("daemon: node.exe with __daemon and our cli", async () => {
    const exec = withCim(fakeExec(node42), { Name: "node.exe", CommandLine: `node ${CLI} __daemon` });
    expect(await isAliveWin32(exec, 42, daemon, "node.exe")).toBe(true);
  });
  test("daemon: unrelated node.exe that reused the pid", async () => {
    const exec = withCim(fakeExec(node42), { Name: "node.exe", CommandLine: "node C:\\other\\server.js" });
    expect(await isAliveWin32(exec, 42, daemon, "node.exe")).toBe(false);
  });
  test("daemon: our cli without __daemon is not a daemon", async () => {
    const exec = withCim(fakeExec(node42), { Name: "node.exe", CommandLine: `node ${CLI} start` });
    expect(await isAliveWin32(exec, 42, daemon, "node.exe")).toBe(false);
  });
  test("foreground: cli path plus ' start'", async () => {
    const ok = withCim(fakeExec(node42), { Name: "node.exe", CommandLine: `node ${CLI} start --always` });
    expect(await isAliveWin32(ok, 42, fg, "node.exe")).toBe(true);
    const no = withCim(fakeExec(node42), { Name: "node.exe", CommandLine: `node ${CLI} status` });
    expect(await isAliveWin32(no, 42, fg, "node.exe")).toBe(false);
  });
  test("unknown argv is not alive", async () => {
    const exec = withCim(fakeExec(node42), null);
    expect(await isAliveWin32(exec, 42, daemon, "node.exe")).toBe(false);
    expect(await queryWin32Process(exec, 42)).toBeNull();
  });
  test("pid reused by another image never reaches the CIM lookup", async () => {
    const exec = withCim(fakeExec({ [key(42)]: '"chrome.exe","42","Console","1","40,000 K"' }), null);
    expect(await isAliveWin32(exec, 42, daemon, "node.exe")).toBe(false);
    expect(exec.calls).toEqual([key(42)]);
  });
  test("no match", async () => {
    const exec = fakeExec({ [key(42)]: "INFO: No tasks are running which match the specified criteria." });
    expect(await isAliveWin32(exec, 42, daemon)).toBe(false);
  });
});
