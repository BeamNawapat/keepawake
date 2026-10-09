import { spawn } from "node:child_process";

export interface ExecResult {
  /** Exit code, or null when the process was killed (timeout, signal). */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  input?: string;
}

/** The only way core and platform code may touch the OS. Tests swap in a fake. */
export interface Exec {
  run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
}

/**
 * Real implementation. A missing binary resolves with code 127 instead of
 * rejecting, so callers handle "tool not installed" the same as "tool failed".
 */
export const nodeExec: Exec = {
  run(cmd, args, opts = {}) {
    return new Promise<ExecResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (r: ExecResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(r);
      };

      const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;

      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", (e: NodeJS.ErrnoException) =>
        done({ code: e.code === "ENOENT" ? 127 : 126, stdout, stderr: stderr || e.message }),
      );
      child.on("close", (code) => done({ code, stdout, stderr }));
      // EPIPE when the child exits before reading stdin is not an error for us.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    });
  },
};
