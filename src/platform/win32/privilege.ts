import type { Exec } from "../../ports/exec.js";
import type { PrivilegePort } from "../../ports/privilege.js";

export function createWin32Privilege(exec: Exec): PrivilegePort {
  return {
    // `net session` needs an elevated token and exits 0 only then, in any UI language.
    async isElevated() {
      const r = await exec.run("net", ["session"], { timeoutMs: 5000 });
      return r.code === 0;
    },
    // UAC has no cached ticket like sudo, so there is nothing to warm up. The
    // prompt appears when the elevated command runs.
    async prepare() {
      return true;
    },
  };
}
