import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutostartPort } from "../../ports/autostart.js";
import type { Exec } from "../../ports/exec.js";

export const LAUNCH_LABEL = "com.beamnawapat.keepawake";

export interface DarwinAutostartDeps {
  home: string;
  nodePath: string;
  cliPath: string;
  logFile: string;
  uid: number;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildPlist(d: DarwinAutostartDeps, args: string[]): string {
  const argv = [d.nodePath, d.cliPath, "start", ...args].map((a) => `        <string>${esc(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argv}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${esc(d.logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${esc(d.logFile)}</string>
</dict>
</plist>
`;
}

export function createDarwinAutostart(exec: Exec, d: DarwinAutostartDeps): AutostartPort {
  const dir = join(d.home, "Library", "LaunchAgents");
  const path = join(dir, `${LAUNCH_LABEL}.plist`);
  const domain = `gui/${d.uid}`;

  async function unload(): Promise<void> {
    const r = await exec.run("launchctl", ["bootout", `${domain}/${LAUNCH_LABEL}`], { timeoutMs: 10000 });
    if (r.code !== 0) await exec.run("launchctl", ["unload", path], { timeoutMs: 10000 });
  }

  return {
    async install(args) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, buildPlist(d, args));
      // bootstrap fails if the label is already loaded, so drop any previous copy first.
      await unload();
      const r = await exec.run("launchctl", ["bootstrap", domain, path], { timeoutMs: 10000 });
      if (r.code !== 0) {
        const legacy = await exec.run("launchctl", ["load", path], { timeoutMs: 10000 });
        if (legacy.code !== 0) throw new Error(`launchctl could not load ${path} (exit ${legacy.code})`);
      }
      return { path };
    },
    async remove() {
      if (!existsSync(path)) return false;
      await unload();
      unlinkSync(path);
      return true;
    },
    async isInstalled() {
      return existsSync(path);
    },
  };
}
