import { writeFileSync } from "node:fs";
import { parseIgnore } from "../core/config.js";
import { AGENTS } from "../core/agents.js";
import { detectAgents } from "../core/detector.js";
import { installCleanup } from "../core/lifecycle.js";
import { createLogger } from "../core/logger.js";
import type { Effect } from "../core/monitor.js";
import { runLoop } from "../core/runner.js";
import { readState, writeState, type State } from "../core/state.js";
import { GLYPH } from "../core/ui.js";
import { VERSION } from "../version.js";
import type { Holder } from "../ports/power.js";
import { clearFiles, cliPath, type Ctx } from "./common.js";

/**
 * The monitor loop, shared by `start` (foreground) and `__daemon`. Options come
 * from state.json, which `start` wrote before getting here.
 * Returns the process exit code.
 */
export async function runMonitor(ctx: Ctx, mode: "foreground" | "daemon"): Promise<number> {
  const { ui, paths } = ctx;
  const saved = readState(paths.state);
  if (!saved) {
    ui.err("no state.json found; run `keepawake start`");
    return 1;
  }
  const opts = saved.options;
  const platform = ctx.makePlatform(opts.lid);
  const logger = createLogger(paths.log);
  // A detached daemon's stdout is the log file, which the logger already writes.
  const show = (m: string): void => {
    if (mode === "foreground") ui.line(m);
  };

  let state: State = { ...saved, pid: process.pid, mode, cli: cliPath() };
  const save = (patch: Partial<State> = {}): void => {
    state = { ...state, ...patch };
    writeState(paths.state, state);
  };
  save();
  writeFileSync(paths.pid, String(process.pid));

  let holder: Holder | null = null;
  let fatal: Error | null = null;
  const abort = new AbortController();

  async function releaseOurs(h: Holder): Promise<void> {
    const result = await platform.power.release({ pid: h.pid, ownerPid: process.pid });
    if (result === "skipped") logger.log(`holder ${h.pid} did not match the expected command line, left alone`);
  }

  let cleaning: Promise<void> | null = null;
  const cleanup = (): Promise<void> => (cleaning ??= doCleanup());
  async function doCleanup(): Promise<void> {
    abort.abort();
    if (holder) {
      try {
        await releaseOurs(holder);
      } catch (e) {
        logger.log(`release failed: ${(e as Error).message}`);
      }
      holder = null;
    }
    if (mode === "foreground") {
      // A foreground process still owns the terminal, so sudo/UAC can prompt here.
      if (state.lid) {
        try {
          await platform.lid.restore(state.lid);
          state = { ...state, lid: null };
        } catch (e) {
          ui.warn(`could not restore the lid setting: ${(e as Error).message}`);
          logger.log("lid restore failed; snapshot kept in state.json");
        }
      }
      if (!state.lid) clearFiles(paths);
      else save({ holderPid: null });
      show("");
      show(`  ${GLYPH.sleep} keepawake stopped -> sleep allowed`);
    } else if (state.lid) {
      // A detached daemon has no tty and no sudo ticket. `stop` does the restore.
      save({ holderPid: null });
      logger.log("daemon exited with the lid setting still applied; run `keepawake stop` to restore it");
    } else {
      clearFiles(paths);
    }
    logger.log("daemon stopped");
  }
  installCleanup(cleanup);

  if (mode === "foreground") {
    ui.header(`keepawake v${VERSION}`);
    ui.info(`PID: ${process.pid}`);
    ui.info(`Check interval: ${opts.interval}s`);
    if (opts.always) ui.warn("Mode: always-on (no agent detection)");
    if (opts.lid) ui.warn("Lid mode: ON  - ปิดฝาแล้วเครื่องยังทำงาน");
    else ui.dim("Lid mode: off - ปิดฝาจะ sleep ตามปกติ");
    if (opts.hotspot) ui.info(`Hotspot: ${ui.paint.yellow(opts.hotspot)} - เน็ตหลุดจะต่อ hotspot อัตโนมัติ`);
    else ui.dim("Hotspot: off - ไม่ auto-connect");
    ui.info(`Log: ${paths.log}`);
    ui.line("");
    ui.dim("กด Ctrl+C เพื่อหยุด");
    ui.line("");
  }
  logger.log(
    `=== started (PID ${process.pid}, mode=${mode}, always=${opts.always}, lid=${opts.lid}, hotspot=${opts.hotspot ? "set" : "none"}, interval=${opts.interval}s) ===`,
  );

  const ignore = parseIgnore(ctx.env);
  const labelOf = (agents: string[]): string => agents.join(", ");

  async function execute(effect: Effect): Promise<void> {
    switch (effect.type) {
      case "acquire": {
        try {
          holder = await platform.power.acquire({ display: opts.display, ownerPid: process.pid });
        } catch (e) {
          // The reducer already believes we are awake; without a holder this run is pointless.
          fatal = e as Error;
          logger.log(`acquire failed: ${fatal.message}`);
          abort.abort();
          return;
        }
        save({ holderPid: holder.pid });
        if (effect.reason === "always") {
          show(`  ${GLYPH.bolt} Always-on: keeping machine awake...`);
          logger.log("always-on -> awake");
        } else {
          show(`  ${GLYPH.bolt} ${ui.paint.bold("Detected:")} ${labelOf(effect.agents)}`);
          show(`  ${GLYPH.bolt} Keeping machine awake...`);
          logger.log(`detected: ${labelOf(effect.agents)} -> awake`);
        }
        return;
      }
      case "release": {
        if (holder) {
          await releaseOurs(holder);
          holder = null;
          save({ holderPid: null });
        }
        const why = effect.reason === "expired" ? "--for time is up" : "Agents stopped";
        show(`  ${GLYPH.sleep} ${why} -> sleep allowed`);
        logger.log(`${why} -> sleep allowed`);
        return;
      }
      case "connect-hotspot": {
        if (effect.firstAttempt) {
          show(`  ${GLYPH.dish} เน็ตหลุด -> กำลังต่อ ${effect.ssid}...`);
          logger.log("internet down -> connecting to the configured hotspot");
        }
        const ok = await platform.network.connectWifi(effect.ssid);
        if (!ok) logger.log("hotspot connect command failed, will retry");
        return;
      }
      case "hotspot-restored":
        show(`  ${GLYPH.wifi} ต่อ ${effect.ssid} สำเร็จ - เน็ตกลับมาแล้ว`);
        logger.log("internet is back after hotspot attempt");
        return;
      case "expire":
        logger.log("--for deadline reached");
        return;
    }
  }

  const startedAt = Date.parse(state.startedAt);
  await runLoop({
    config: {
      always: opts.always,
      hotspot: opts.hotspot,
      expiresAt: opts.for !== null ? startedAt + opts.for * 1000 : null,
    },
    intervalMs: opts.interval * 1000,
    signal: abort.signal,
    async observe() {
      const procs = await platform.processes.list();
      const found = detectAgents(procs, AGENTS, {
        selfPids: [process.pid, process.ppid],
        includeApps: opts.apps,
        ignore,
      });
      return {
        agents: found.map((a) => a.label),
        online: opts.hotspot ? await platform.network.isOnline() : null,
      };
    },
    execute: (effect) => execute(effect),
    // Only the message: exec errors can carry stderr, never argv.
    onError: (e) => logger.log(`error: ${(e as Error).message}`),
  });

  await cleanup();
  if (fatal) {
    ui.err((fatal as Error).message);
    return 1;
  }
  return 0;
}
