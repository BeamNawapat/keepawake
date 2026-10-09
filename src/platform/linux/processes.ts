import type { Exec } from "../../ports/exec.js";
import type { ProcessLister } from "../../ports/processes.js";
import { createPosixProcessLister } from "../posix-ps.js";

/** procps `ps` accepts the same flags as BSD ps for the two columns we read. */
export function createLinuxProcessLister(exec: Exec): ProcessLister {
  return createPosixProcessLister(exec);
}
