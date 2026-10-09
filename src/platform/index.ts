import { realpathSync } from "node:fs";
import type { AutostartPort } from "../ports/autostart.js";
import type { Exec } from "../ports/exec.js";
import type { LidPort } from "../ports/lid.js";
import type { NetworkPort } from "../ports/network.js";
import type { PowerPort } from "../ports/power.js";
import type { PrivilegePort } from "../ports/privilege.js";
import type { ProcessLister } from "../ports/processes.js";
import { createDarwinPlatform } from "./darwin/index.js";
import { isOnline } from "./darwin/tcp-probe.js";
import { createLinuxAutostart } from "./linux/autostart.js";
import { createLinuxLid } from "./linux/lid.js";
import { createLinuxNetwork } from "./linux/network.js";
import { createLinuxPower } from "./linux/power.js";
import { createLinuxPrivilege } from "./linux/privilege.js";
import { createLinuxProcessLister } from "./linux/processes.js";
import { isAliveWin32 } from "./win32/alive.js";
import { createWin32Autostart } from "./win32/autostart.js";
import { createWin32Lid } from "./win32/lid.js";
import { createWin32Network } from "./win32/network.js";
import { createWin32Power } from "./win32/power.js";
import { createWin32Privilege } from "./win32/privilege.js";
import { createWin32ProcessLister } from "./win32/processes.js";

export interface Platform {
  power: PowerPort;
  lid: LidPort;
  processes: ProcessLister;
  network: NetworkPort;
  privilege: PrivilegePort;
  autostart: AutostartPort;
  /** True when `pid` is a live keepawake process of the given mode (guards against pid reuse). */
  isAlive(pid: number, expect: AliveExpect): Promise<boolean>;
}

export interface AliveExpect {
  mode: "daemon" | "foreground";
  /** realpath of the cli entry recorded in state.json. */
  cli: string;
}

/** A symlinked bin shows up in ps under the link path, while state.json holds the realpath. */
function sameFile(token: string, cli: string): boolean {
  try {
    return realpathSync(token) === cli;
  } catch {
    return false;
  }
}

/** Exported for tests. Unknown argv counts as not ours: killing a stranger is worse than a stale state. */
export function matchesArgv(args: string | undefined, expect: AliveExpect): boolean {
  if (args === undefined || expect.cli === "") return false;
  if (expect.mode === "daemon") return args.includes("__daemon") && args.includes(expect.cli);
  if (!args.includes(" start")) return false;
  return args.includes(expect.cli) || args.split(/\s+/).some((t) => sameFile(t, expect.cli));
}

function posixIsAlive(processes: ProcessLister) {
  return async (pid: number, expect: AliveExpect): Promise<boolean> => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
    } catch (e) {
      // EPERM means the process exists but belongs to someone else.
      if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
    }
    const p = (await processes.list()).find((x) => x.pid === pid);
    if (!p) return false;
    return matchesArgv(p.args, expect);
  };
}

/** `lid` only matters on Linux, where the inhibitor flag is fixed when the holder starts. */
export function createPlatform(exec: Exec, opts: { lid?: boolean } = {}): Platform {
  switch (process.platform) {
    case "darwin": {
      const p = createDarwinPlatform(exec);
      return { ...p, isAlive: posixIsAlive(p.processes) };
    }
    case "win32":
      return {
        power: createWin32Power(exec),
        lid: createWin32Lid(exec),
        processes: createWin32ProcessLister(exec),
        network: createWin32Network(exec),
        privilege: createWin32Privilege(exec),
        autostart: createWin32Autostart(exec),
        isAlive: (pid, expect) => isAliveWin32(exec, pid, expect),
      };
    default: {
      const processes = createLinuxProcessLister(exec);
      return {
        power: createLinuxPower(exec, { lid: opts.lid === true }),
        lid: createLinuxLid(),
        processes,
        network: createLinuxNetwork(exec, isOnline),
        privilege: createLinuxPrivilege(),
        autostart: createLinuxAutostart(exec),
        isAlive: posixIsAlive(processes),
      };
    }
  }
}
