import type { Exec } from "../ports/exec.js";
import type { ProcessInfo, ProcessLister } from "../ports/processes.js";

const COMM_LINE = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/;
const ARGS_LINE = /^\s*(\d+)\s+(.*\S)\s*$/;

/** Output of `ps -axo pid=,ppid=,comm=`. comm may contain spaces ("Cursor Helper"). */
export function parsePsComm(text: string): Array<Pick<ProcessInfo, "pid" | "ppid" | "comm">> {
  const out: Array<Pick<ProcessInfo, "pid" | "ppid" | "comm">> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = COMM_LINE.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]! });
  }
  return out;
}

/** Output of `ps -axo pid=,args=`, keyed by pid. */
export function parsePsArgs(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = ARGS_LINE.exec(line);
    if (m) map.set(Number(m[1]), m[2]!);
  }
  return map;
}

export function joinPs(commText: string, argsText: string): ProcessInfo[] {
  const args = parsePsArgs(argsText);
  return parsePsComm(commText).map((p) => {
    const a = args.get(p.pid);
    return a === undefined ? p : { ...p, args: a };
  });
}

/**
 * Two ps calls instead of one `comm=,args=` call because comm can contain
 * spaces, which makes a single combined line impossible to split reliably.
 */
export function createPosixProcessLister(exec: Exec): ProcessLister {
  return {
    async list() {
      const [comm, args] = await Promise.all([
        exec.run("ps", ["-axo", "pid=,ppid=,comm="], { timeoutMs: 5000 }),
        exec.run("ps", ["-axo", "pid=,args="], { timeoutMs: 5000 }),
      ]);
      if (comm.code !== 0) throw new Error(`ps failed (exit ${comm.code})`);
      // A failed args call degrades to comm-only detection instead of failing the tick.
      return joinPs(comm.stdout, args.code === 0 ? args.stdout : "");
    },
  };
}
