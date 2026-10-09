import type { PrivilegePort } from "../../ports/privilege.js";

/** Linux needs no elevation: systemd-inhibit and the --user unit both run as the user. */
export function createLinuxPrivilege(): PrivilegePort {
  return {
    async isElevated() {
      return true;
    },
    async prepare() {
      return true;
    },
  };
}
