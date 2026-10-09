import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Exec } from "../../ports/exec.js";
import type { HolderOptions, PowerPort } from "../../ports/power.js";

export type SpawnFn = (cmd: string, args: string[]) => ChildProcess;

const defaultSpawn: SpawnFn = (cmd, args) => nodeSpawn(cmd, args, { stdio: "ignore" });

export function caffeinateArgs(opts: HolderOptions): string[] {
  // -w makes caffeinate exit by itself when the daemon dies, so a kill -9 cannot leak an assertion.
  return ["-i", "-m", "-s", ...(opts.display ? ["-d"] : []), "-w", String(opts.ownerPid)];
}

export function createDarwinPower(exec: Exec, spawnFn: SpawnFn = defaultSpawn): PowerPort {
  return {
    async acquire(opts) {
      const child = spawnFn("/usr/bin/caffeinate", caffeinateArgs(opts));
      const pid = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", () => (child.pid ? resolve(child.pid) : reject(new Error("caffeinate has no pid"))));
      });
      child.unref();
      return { pid };
    },
    async release(holder: { pid: number; ownerPid: number }) {
      // Pids get reused, and state.json survives reboots. Kill only a caffeinate that waits on our daemon.
      const r = await exec.run("ps", ["-p", String(holder.pid), "-o", "args="], { timeoutMs: 5000 });
      if (r.code !== 0) return false;
      const argv = r.stdout.trim().split(/\s+/);
      if (!argv[0]?.endsWith("caffeinate")) return false;
      const w = argv.indexOf("-w");
      if (w === -1 || argv[w + 1] !== String(holder.ownerPid)) return false;
      await exec.run("kill", [String(holder.pid)], { timeoutMs: 5000 });
      return true;
    },
  };
}
