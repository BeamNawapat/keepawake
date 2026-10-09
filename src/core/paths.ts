import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  dir: string;
  pid: string;
  state: string;
  /** Held by a `start` in progress so two starts cannot both spawn a daemon. */
  lock: string;
  log: string;
  logOld: string;
}

/**
 * State lives under the home directory, not os.tmpdir(): macOS clears /tmp on
 * reboot, but `pmset disablesleep` survives a reboot, so the restore snapshot
 * has to survive too.
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Paths {
  const dir = env.KEEPAWAKE_HOME || join(home, ".keepawake");
  return {
    dir,
    pid: join(dir, "daemon.pid"),
    state: join(dir, "state.json"),
    lock: join(dir, "start.lock"),
    log: join(dir, "keepawake.log"),
    logOld: join(dir, "keepawake.log.old"),
  };
}
