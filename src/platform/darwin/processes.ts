import type { Exec } from "../../ports/exec.js";
import type { ProcessLister } from "../../ports/processes.js";
import { createPosixProcessLister } from "../posix-ps.js";

export function createDarwinProcessLister(exec: Exec): ProcessLister {
  return createPosixProcessLister(exec);
}
