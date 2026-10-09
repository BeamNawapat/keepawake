import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Exec } from "../../ports/exec.js";
import type { Holder, HolderOptions, PowerPort, ReleaseResult } from "../../ports/power.js";
import { UnsupportedError } from "./errors.js";

/** Starts a long-lived helper and resolves with its pid once it exists. */
export type SpawnHolder = (cmd: string, args: string[]) => Promise<{ pid: number }>;

export interface LinuxPowerOptions {
  /** Also block lid-close suspend (the --lid flag). Lives here because HolderOptions has no lid field. */
  lid?: boolean;
  spawnHolder?: SpawnHolder;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/** How long a fresh holder must stay alive before we trust that logind/polkit accepted it. */
const SETTLE_MS = 400;

const nodeSpawnHolder: SpawnHolder = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let exited = false;
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.once("exit", () => (exited = true));
    child.once("error", reject);
    child.once("spawn", () => {
      // Late failures (inhibitor killed) surface as a dead pid, not an unhandled event.
      child.removeListener("error", reject);
      child.on("error", () => {});
      // systemd-inhibit spawns fine and then exits at once when logind or polkit refuses,
      // so "spawned" alone does not mean the lock is held.
      setTimeout(() => {
        if (exited || child.exitCode !== null || child.signalCode !== null) {
          reject(new Error(stderr.trim() || `systemd-inhibit exited (code ${child.exitCode ?? child.signalCode})`));
          return;
        }
        // Destroying the pipe would make a later stderr write from systemd-inhibit/sleep
        // raise SIGPIPE and kill the holder, so keep draining it for the process lifetime.
        child.stderr!.removeAllListeners("data");
        child.stderr!.on("data", () => {});
        child.unref();
        resolve({ pid: child.pid! });
      }, SETTLE_MS);
    });
  });

export function inhibitArgs(opts: { lid: boolean }): string[] {
  const what = opts.lid ? "idle:sleep:handle-lid-switch" : "idle:sleep";
  return [`--what=${what}`, "--who=keepawake", "--why=agent running", "sleep", "infinity"];
}

/**
 * systemd-inhibit holds the lock for as long as `sleep infinity` runs. It does
 * not die with the daemon (unlike caffeinate -w), so a hard-killed daemon
 * leaves an orphan that `doctor` has to reap via state.json holderPid.
 * `display` has no effect: logind has no display-on inhibitor.
 */
export function createLinuxPower(exec: Exec, options: LinuxPowerOptions = {}): PowerPort {
  const spawnHolder = options.spawnHolder ?? nodeSpawnHolder;
  const kill = options.kill ?? ((pid, sig) => process.kill(pid, sig));
  return {
    async acquire(_opts: HolderOptions): Promise<Holder> {
      // --list proves both that the binary exists and that logind answers on D-Bus.
      const probe = await exec.run("systemd-inhibit", ["--list"], { timeoutMs: 5000 });
      if (probe.code === 127) {
        throw new UnsupportedError("systemd-inhibit not found: keepawake needs systemd (logind) on Linux");
      }
      if (probe.code !== 0) {
        throw new UnsupportedError("systemd-inhibit cannot reach logind (no systemd session bus?)");
      }
      try {
        const { pid } = await spawnHolder("systemd-inhibit", inhibitArgs({ lid: options.lid === true }));
        return { pid };
      } catch (e) {
        throw new UnsupportedError(`could not start systemd-inhibit: ${(e as Error).message}`);
      }
    },
    async release(holder: { pid: number; ownerPid: number }): Promise<ReleaseResult> {
      // state.json can outlive a reboot, so the pid may belong to something else by now.
      const r = await exec.run("ps", ["-p", String(holder.pid), "-o", "args="], { timeoutMs: 5000 });
      if (r.code !== 0) return "gone";
      const argv = r.stdout.trim().split(/\s+/);
      if (basename(argv[0] ?? "") !== "systemd-inhibit" || !argv.includes("--who=keepawake")) return "skipped";
      try {
        kill(holder.pid, "SIGTERM");
      } catch (e) {
        // Already gone is the goal state.
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      return "released";
    },
  };
}
