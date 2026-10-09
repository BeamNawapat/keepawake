import { spawn } from "node:child_process";
import { closeSync, openSync, realpathSync } from "node:fs";
import type { Options } from "../core/config.js";
import { GLYPH } from "../core/ui.js";
import { readState, writeState, type State } from "../core/state.js";
import type { Platform } from "../platform/index.js";
import { clearFiles, reconcile, type Ctx } from "./common.js";
import { runMonitor } from "./daemon.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Returns the process exit code. */
export async function start(ctx: Ctx, options: Options, daemon: boolean): Promise<number> {
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
  if (options.lid) {
    // Prompt now, while a terminal is attached. A detached daemon cannot ask.
    ui.line(`\n  ${GLYPH.key} โหมด --lid ต้องใช้สิทธิ์ admin`);
    if (!(await platform.privilege.isElevated()) && !(await platform.privilege.prepare())) {
      ui.err("admin authentication failed; --lid needs it");
      return 1;
    }
    try {
      lid = await platform.lid.apply();
    } catch (e) {
      ui.err((e as Error).message);
      return 1;
    }
  }

  // Written before the daemon exists so a crash between "lid applied" and
  // "daemon running" still leaves the snapshot for the next reconcile.
  const initial: State = {
    version: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    mode: daemon ? "daemon" : "foreground",
    options,
    holderPid: null,
    lid,
  };
  writeState(paths.state, initial);

  if (!daemon) return runMonitor(ctx, "foreground");

  if (options.always && options.lid && options.for === null) {
    ui.warn("--always --lid -d with no --for: forgetting to stop keeps the laptop running in a bag. Consider --for 2h.");
  }

  const cli = realpathSync(process.argv[1] ?? "");
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
  if (lid) {
    try {
      await platform.lid.restore(lid);
    } catch (e) {
      ctx.ui.warn(`could not restore the lid setting: ${(e as Error).message}`);
      return; // keep state.json so reconcile can retry
    }
  }
  clearFiles(ctx.paths);
}
