import { readState } from "../core/state.js";
import { startInProgress } from "./start.js";
import { clearFiles, lidChanged, releaseHolder, type Ctx } from "./common.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Kills the daemon, then always releases the holder, restores the lid setting
 * and clears state. The cleanup does not rely on the daemon's own handlers:
 * SIGKILL and `taskkill /F` skip them.
 */
export async function stop(ctx: Ctx, opts: { quiet?: boolean } = {}): Promise<number> {
  const { ui, paths } = ctx;
  const say = opts.quiet ? () => {} : (m: string) => ui.info(m);
  const platform = ctx.makePlatform(false);

  // Until the daemon rewrites state.json, it names the start process, which looks stale.
  const starting = startInProgress(paths);
  if (starting !== null) {
    ui.err(`a start is in progress (pid ${starting}), try again in a moment`);
    return 1;
  }

  const state = readState(paths.state);
  if (!state) {
    clearFiles(paths);
    if (!opts.quiet) ui.warn("Daemon is not running");
    return 0;
  }

  const alive = { mode: state.mode, cli: state.cli };
  if (await platform.isAlive(state.pid, alive)) {
    say(`Stopping daemon (PID ${state.pid})...`);
    if (process.platform === "win32") {
      // /F skips signal handlers, which is why the cleanup below is not optional.
      await ctx.exec.run("taskkill", ["/PID", String(state.pid), "/T", "/F"], { timeoutMs: 15000 });
    } else {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // exited between the check and the kill
      }
      for (let i = 0; i < 50 && (await platform.isAlive(state.pid, alive)); i++) await sleep(100);
      if (await platform.isAlive(state.pid, alive)) {
        try {
          process.kill(state.pid, "SIGKILL");
        } catch {
          // gone already
        }
        ui.warn("Force killed");
      }
    }
  } else {
    ui.warn("Daemon was not running (stale state, cleaning up)");
  }

  // The daemon may have updated state.json while shutting down.
  const latest = readState(paths.state) ?? state;
  await releaseHolder(ctx, platform, latest);
  if (lidChanged(latest.lid)) {
    try {
      await platform.lid.restore(latest.lid);
    } catch (e) {
      ui.err(`could not restore the lid setting: ${(e as Error).message}`);
      ui.dim("state.json kept; run `keepawake stop` again from a terminal that can ask for admin rights");
      return 1;
    }
  }
  clearFiles(paths);
  say("Daemon stopped");
  return 0;
}
