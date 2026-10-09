import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutostartPort } from "../../ports/autostart.js";
import type { Exec } from "../../ports/exec.js";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE = "keepawake";

/** VBScript string literal: only the double quote needs escaping. */
const vbs = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function buildStartVbs(args: string[]): string {
  // Each arg is wrapped in quotes for CreateProcess. A literal quote inside an
  // arg cannot be expressed portably, so it is rejected instead of guessed at.
  if (args.some((a) => a.includes('"'))) throw new Error("autostart arguments cannot contain double quotes");
  const cmd = args.map((a) => `"${a}"`).join(" ");
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run ${vbs(cmd)}, 0, False`,
    "",
  ].join("\r\n");
}

export function createWin32Autostart(
  exec: Exec,
  opts: { appData?: string } = {},
): AutostartPort {
  const dir = () => {
    const base = opts.appData ?? process.env.APPDATA;
    if (!base) throw new Error("APPDATA is not set");
    return join(base, "keepawake");
  };
  return {
    async install(args) {
      const script = buildStartVbs(args);
      const folder = dir();
      const path = join(folder, "start.vbs");
      await mkdir(folder, { recursive: true });
      // WSH reads .vbs in the ANSI code page unless there is a UTF-16 BOM, which mangles non-ASCII paths.
      await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, "utf16le")]));
      const r = await exec.run(
        "reg",
        ["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", `wscript.exe "${path}"`, "/f"],
        { timeoutMs: 10000 },
      );
      if (r.code !== 0) throw new Error(`could not write the Run key (exit ${r.code})`);
      return { path };
    },
    async remove() {
      const r = await exec.run("reg", ["delete", RUN_KEY, "/v", VALUE, "/f"], { timeoutMs: 10000 });
      await rm(join(dir(), "start.vbs"), { force: true });
      return r.code === 0;
    },
    async isInstalled() {
      const r = await exec.run("reg", ["query", RUN_KEY, "/v", VALUE], { timeoutMs: 10000 });
      return r.code === 0;
    },
  };
}
