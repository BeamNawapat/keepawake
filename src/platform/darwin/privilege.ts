import type { Exec } from "../../ports/exec.js";
import type { PrivilegePort } from "../../ports/privilege.js";
import { GLYPH } from "../../core/ui.js";
import { runInteractive, type RunInteractive } from "./interactive.js";

export interface DarwinPrivilegeDeps {
  interactive?: RunInteractive;
  write?: (text: string) => void;
}

export function createDarwinPrivilege(exec: Exec, deps: DarwinPrivilegeDeps = {}): PrivilegePort {
  const interactive = deps.interactive ?? runInteractive;
  const write = deps.write ?? ((t) => void process.stdout.write(t));
  return {
    async isElevated() {
      // -n: never prompt. Exit 0 only when a sudo ticket is still valid.
      return (await exec.run("sudo", ["-n", "true"], { timeoutMs: 5000 })).code === 0;
    },
    async prepare() {
      write(`  ${GLYPH.key} โหมด --lid ต้องใช้สิทธิ์ admin\n`);
      write("  กรุณาใส่รหัสผ่าน Mac: ");
      // sudo -v writes its own prompt to the tty, so it must inherit stdio rather than go through Exec.
      const code = await interactive("sudo", ["-v"]);
      if (code !== 0) return false;
      write(`  ${GLYPH.ok} รหัสถูกต้อง — sudo พร้อมใช้\n`);
      return true;
    },
  };
}
