import { spawn } from "node:child_process";

/** Runs a command attached to the user's terminal (sudo needs a tty to prompt). Resolves with the exit code. */
export type RunInteractive = (cmd: string, args: string[]) => Promise<number | null>;

export const runInteractive: RunInteractive = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code));
  });
