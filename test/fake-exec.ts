import type { Exec, ExecResult } from "../src/ports/exec.js";

type Reply = string | Partial<ExecResult> | ((args: string[]) => string | Partial<ExecResult>);

export interface FakeExec extends Exec {
  /** Every call as "cmd arg1 arg2", in order. */
  calls: string[];
}

/**
 * Keys are "cmd arg1 arg2". A string reply is stdout with exit 0. Anything
 * not listed fails with code 127, so a test notices an unexpected OS call.
 */
export function fakeExec(replies: Record<string, Reply> = {}): FakeExec {
  const calls: string[] = [];
  return {
    calls,
    async run(cmd, args) {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      const reply = replies[key];
      if (reply === undefined) return { code: 127, stdout: "", stderr: `fakeExec: no reply for "${key}"` };
      const r = typeof reply === "function" ? reply(args) : reply;
      if (typeof r === "string") return { code: 0, stdout: r, stderr: "" };
      return { code: 0, stdout: "", stderr: "", ...r };
    },
  };
}
