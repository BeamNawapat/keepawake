import { homedir } from "node:os";
import { resolvePaths } from "../../core/paths.js";
import type { Exec } from "../../ports/exec.js";
import { createDarwinAutostart } from "./autostart.js";
import { createDarwinLid } from "./lid.js";
import { createDarwinNetwork } from "./network.js";
import { createDarwinPower } from "./power.js";
import { createDarwinPrivilege } from "./privilege.js";
import { createDarwinProcessLister } from "./processes.js";

export function createDarwinPlatform(exec: Exec) {
  const privilege = createDarwinPrivilege(exec);
  return {
    power: createDarwinPower(exec),
    lid: createDarwinLid(exec, privilege),
    processes: createDarwinProcessLister(exec),
    network: createDarwinNetwork(exec),
    privilege,
    autostart: createDarwinAutostart(exec, {
      home: homedir(),
      nodePath: process.execPath,
      cliPath: process.argv[1] ?? "",
      logFile: resolvePaths().log,
      uid: process.getuid?.() ?? 0,
    }),
  };
}
