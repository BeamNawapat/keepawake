import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutostartPort } from "../../ports/autostart.js";
import type { Exec } from "../../ports/exec.js";

const UNIT = "keepawake.service";

/** systemd treats % and $ specially inside ExecStart, so double them. */
export function quoteSystemd(arg: string): string {
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/** `args` is the full command: [node, cli, "start", ...flags]. */
export function renderUnit(args: string[]): string {
  return [
    "[Unit]",
    "Description=keepawake: keep the machine awake while coding agents run",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${args.map(quoteSystemd).join(" ")}`,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function createLinuxAutostart(exec: Exec, home: string = homedir()): AutostartPort {
  const dir = join(home, ".config", "systemd", "user");
  const path = join(dir, UNIT);
  const systemctl = (...a: string[]) => exec.run("systemctl", ["--user", ...a], { timeoutMs: 15000 });
  return {
    async install(args) {
      await mkdir(dir, { recursive: true });
      await writeFile(path, renderUnit(args), "utf8");
      const reload = await systemctl("daemon-reload");
      if (reload.code !== 0) throw new Error(`systemctl --user daemon-reload failed: ${reload.stderr.trim()}`);
      const enable = await systemctl("enable", "--now", UNIT);
      if (enable.code !== 0) throw new Error(`systemctl --user enable failed: ${enable.stderr.trim()}`);
      return { path };
    },
    async remove() {
      if (!(await this.isInstalled())) return false;
      // Ignore disable failure: the unit may already be disabled, and we still want the file gone.
      await systemctl("disable", "--now", UNIT);
      await rm(path, { force: true });
      await systemctl("daemon-reload");
      return true;
    },
    async isInstalled() {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
