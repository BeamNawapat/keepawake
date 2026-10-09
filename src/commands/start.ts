import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import type { Options } from "../core/config.js";
import { GLYPH } from "../core/ui.js";
import { readState, writeState, type State } from "../core/state.js";
import type { LidSnapshot } from "../ports/lid.js";
import type { Platform } from "../platform/index.js";
import type { Paths } from "../core/paths.js";
import { clearFiles, cliPath, lidChanged, reconcile, type Ctx } from "./common.js";
import { runMonitor } from "./daemon.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A lock file with no readable pid is only trusted this long (the writer may be between open and write). */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockHolderAlive(file: string): boolean {
  let pid = Number.NaN;
  try {
    pid = Number(readFileSync(file, "utf8").trim());
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT"; // vanished = free
  }
  if (Number.isInteger(pid) && pid > 0) return pidExists(pid);
  try {
    return Date.now() - statSync(file).mtimeMs < UNREADABLE_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Exclusive `start.lock` holding our pid. Returns a release function, or null
 * when another live start owns it. A lock left by a dead process is removed
 * and taken once more. Exported for tests.
 */
export function acquireStartLock(paths: Paths): (() => void) | null {
  mkdirSync(paths.dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.lock, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(paths.lock);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (lockHolderAlive(paths.lock)) return null;
      // Two starters can both see the same dead lock. rename() succeeds for only one of them
      // (the loser gets ENOENT), so only the winner retries; a plain unlink would let both
      // succeed and the second could delete the lock the first had just created.
      const stale = `${paths.lock}.${process.pid}.stale`;
      try {
        renameSync(paths.lock, stale);
      } catch {
        return null;
      }
      try {
        unlinkSync(stale);
      } catch {
        // already gone
      }
    }
  }
  return null;
}

/** Pid of another live start holding start.lock, or null. stop and doctor back off while one runs. */
export function startInProgress(paths: Paths): number | null {
  let pid = Number.NaN;
  try {
    pid = Number(readFileSync(paths.lock, "utf8").trim());
  } catch {
    return null;
  }
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidExists(pid) ? pid : null;
}

/** Returns the process exit code. */
export async function start(ctx: Ctx, options: Options, daemon: boolean): Promise<number> {
  // Taken before reconcile: a second start must not "clean" the first start's
  // state.json while that start is still between writing it and spawning.
  const release = acquireStartLock(ctx.paths);
  if (!release) {
    ctx.ui.err("Already running / another start in progress");
    ctx.ui.dim(`if that is wrong, remove ${ctx.paths.lock}`);
    return 1;
  }
  try {
    return await startLocked(ctx, options, daemon, release);
  } finally {
    release();
  }
}

async function startLocked(ctx: Ctx, options: Options, daemon: boolean, releaseLock: () => void): Promise<number> {
  const { ui, paths } = ctx;
  const platform = ctx.makePlatform(options.lid);

  const rec = await reconcile(ctx, platform, { restoreLid: true });
  if (rec.kind === "alive") {
    ui.err(`Already running (PID ${rec.state.pid})`);
    ui.dim("use `keepawake stop` or `keepawake restart`");
    return 1;
  }
  if (rec.kind === "blocked") {
    ui.err("an earlier run left the lid setting changed and it could not be restored; fix that first");
    return 1;
  }
  if (rec.kind === "cleaned") ui.warn("cleaned stale state from a previous run");

  let lid: State["lid"] = null;
  let snapshot: LidSnapshot | null = null;
  if (options.lid) {
    // Prompt now, while a terminal is attached. A detached daemon cannot ask.
    if (!(await platform.privilege.isElevated()) && !(await platform.privilege.prepare())) {
      ui.err("admin authentication failed; --lid needs it");
      return 1;
    }
    try {
      const snap = await platform.lid.snapshot();
      lid = lidChanged(snap) ? snap : null;
      snapshot = snap;
    } catch (e) {
      ui.err((e as Error).message);
      return 1;
    }
  }

  const cli = cliPath();

  // Written before set() touches the system, and before the daemon exists, so a
  // crash anywhere after this point still leaves the snapshot for reconcile.
  const initial: State = {
    version: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    mode: daemon ? "daemon" : "foreground",
    cli,
    options,
    holderPid: null,
    lid,
  };
  writeState(paths.state, initial);

  if (snapshot) {
    try {
      await platform.lid.set(snapshot);
    } catch (e) {
      ui.err((e as Error).message);
      await undo(ctx, platform, lid);
      return 1;
    }
  }

  if (!daemon) {
    // state.json already names this process, so the lock has done its job; a
    // foreground run lasts hours and must not block other commands.
    releaseLock();
    return runMonitor(ctx, "foreground");
  }

  if (options.always && options.lid && options.for === null) {
    ui.warn("--always --lid -d with no --for: forgetting to stop keeps the laptop running in a bag. Consider --for 2h.");
  }

  const win = process.platform === "win32";
  const fd = win ? null : openSync(paths.log, "a");
  let childPid: number | undefined;
  try {
    const child = spawn(process.execPath, [cli, "__daemon"], {
      detached: true,
      windowsHide: true,
      env: process.env,
      stdio: win || fd === null ? "ignore" : ["ignore", fd, fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => resolve());
    });
    child.unref();
    childPid = child.pid;
  } catch (e) {
    ui.err(`could not start the daemon: ${(e as Error).message}`);
    await undo(ctx, platform, lid);
    return 1;
  } finally {
    if (fd !== null) closeSync(fd);
  }

  // The daemon rewrites state.json with its own pid once it is running.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (readState(paths.state)?.pid === childPid) break;
    await sleep(100);
  }
  if (readState(paths.state)?.pid !== childPid) {
    ui.err("daemon did not come up within 5s");
    ui.dim(`see ${paths.log}`);
    if (childPid !== undefined) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // already exited
      }
    }
    await undo(ctx, platform, lid);
    return 1;
  }

  ui.info("Starting in background...");
  ui.info(`Daemon PID: ${childPid}`);
  ui.dim(`log:  keepawake log   (${paths.log})`);
  ui.dim("stop: keepawake stop");
  return 0;
}

async function undo(ctx: Ctx, platform: Platform, lid: State["lid"]): Promise<void> {
  if (lidChanged(lid)) {
    try {
      await platform.lid.restore(lid);
    } catch (e) {
      ctx.ui.warn(`could not restore the lid setting: ${(e as Error).message}`);
      return; // keep state.json so reconcile can retry
    }
  }
  clearFiles(ctx.paths);
}
