import { realpathSync, unlinkSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultOptions, parseDuration, resolveInterval, type Options } from "../core/config.js";
import { resolvePaths, type Paths } from "../core/paths.js";
import { clearState, readState, type State } from "../core/state.js";
import type { LidSnapshot } from "../ports/lid.js";
import { createUi, type Ui } from "../core/ui.js";
import { nodeExec, type Exec } from "../ports/exec.js";
import { createPlatform, type Platform } from "../platform/index.js";

export interface Ctx {
  exec: Exec;
  paths: Paths;
  ui: Ui;
  env: NodeJS.ProcessEnv;
  makePlatform(lid: boolean): Platform;
}

export function createCtx(): Ctx {
  return {
    exec: nodeExec,
    paths: resolvePaths(),
    ui: createUi(),
    env: process.env,
    makePlatform: (lid) => createPlatform(nodeExec, { lid }),
  };
}

export interface Parsed {
  options: Options;
  daemon: boolean;
  json: boolean;
  fix: boolean;
  /** True when any of the option flags (not -d/--json/--fix) was typed. restart reuses saved flags otherwise. */
  optionFlagsGiven: boolean;
}

export function parseFlags(argv: string[], env: NodeJS.ProcessEnv = process.env): Parsed {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      always: { type: "boolean", short: "a" },
      "no-detect": { type: "boolean" },
      for: { type: "string" },
      lid: { type: "boolean" },
      display: { type: "boolean" },
      hotspot: { type: "string" },
      interval: { type: "string" },
      "no-apps": { type: "boolean" },
      daemon: { type: "boolean", short: "d" },
      background: { type: "boolean" },
      json: { type: "boolean" },
      fix: { type: "boolean" },
    },
  });

  const o = defaultOptions();
  o.always = values.always === true || values["no-detect"] === true;
  if (values.for !== undefined) {
    if (!o.always) throw new Error("--for only works together with --always");
    o.for = parseDuration(values.for);
  }
  o.lid = values.lid === true;
  o.display = values.display === true;
  if (values.hotspot !== undefined) {
    if (values.hotspot.trim() === "") throw new Error("--hotspot needs a Wi-Fi name, e.g. --hotspot Beam");
    o.hotspot = values.hotspot;
  }
  o.interval = resolveInterval(values.interval, env);
  o.apps = values["no-apps"] !== true;

  const optionFlagsGiven = ["always", "no-detect", "for", "lid", "display", "hotspot", "interval", "no-apps"].some(
    (k) => (values as Record<string, unknown>)[k] !== undefined,
  );
  return {
    options: o,
    daemon: values.daemon === true || values.background === true,
    json: values.json === true,
    fix: values.fix === true,
    optionFlagsGiven,
  };
}

/** Flags that rebuild `options` when parsed again (used by setup-auto). */
export function optionsToFlags(o: Options): string[] {
  const f: string[] = [];
  if (o.always) f.push("--always");
  if (o.for !== null) f.push("--for", `${o.for}s`);
  if (o.lid) f.push("--lid");
  if (o.display) f.push("--display");
  if (o.hotspot !== null) f.push("--hotspot", o.hotspot);
  f.push("--interval", String(o.interval));
  if (!o.apps) f.push("--no-apps");
  return f;
}

/** realpath of the running cli entry, recorded in state.json so isAlive can match it against argv. */
export function cliPath(): string {
  const arg = process.argv[1] ?? "";
  try {
    return realpathSync(arg);
  } catch {
    return arg;
  }
}

/** A Linux snapshot is a placeholder: the inhibitor dies with the holder, so there is nothing to restore. */
export function lidChanged(lid: LidSnapshot | null): lid is LidSnapshot {
  return lid !== null && lid.kind !== "linux";
}

/** Releases a recorded holder; says so when the argv check refused to kill it. */
export async function releaseHolder(ctx: Ctx, platform: Platform, state: State): Promise<void> {
  if (state.holderPid === null) return;
  try {
    const result = await platform.power.release({ pid: state.holderPid, ownerPid: state.pid });
    if (result === "skipped") ctx.ui.warn(`holder ${state.holderPid} does not look like ours (pid reused?), left alone`);
  } catch (e) {
    ctx.ui.warn(`could not release holder ${state.holderPid}: ${(e as Error).message}`);
  }
}

export function clearFiles(paths: Paths): void {
  clearState(paths.state);
  try {
    unlinkSync(paths.pid);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export type Reconciled =
  | { kind: "none" }
  | { kind: "alive"; state: State }
  | { kind: "cleaned"; state: State }
  /** State is stale but the lid setting could not be put back, so the snapshot was kept. */
  | { kind: "blocked"; state: State };

/**
 * Turns a state.json whose owner died into a clean slate: release the holder
 * if it outlived the daemon, put the lid setting back, delete the files.
 * `restoreLid: false` is for read-only commands that must not prompt for sudo.
 */
export async function reconcile(ctx: Ctx, platform: Platform, opts: { restoreLid: boolean }): Promise<Reconciled> {
  const state = readState(ctx.paths.state);
  if (!state) {
    // A corrupt state.json reads as null; a leftover pid file alone carries nothing worth keeping.
    return { kind: "none" };
  }
  if (await platform.isAlive(state.pid, { mode: state.mode, cli: state.cli })) return { kind: "alive", state };

  if (lidChanged(state.lid) && !opts.restoreLid) return { kind: "blocked", state };

  await releaseHolder(ctx, platform, state);
  if (lidChanged(state.lid)) {
    try {
      await platform.lid.restore(state.lid);
    } catch (e) {
      ctx.ui.warn(`could not restore the lid setting: ${(e as Error).message}`);
      ctx.ui.dim("run `keepawake doctor --fix` from a terminal that can ask for admin rights");
      return { kind: "blocked", state };
    }
  }
  clearFiles(ctx.paths);
  return { kind: "cleaned", state };
}
