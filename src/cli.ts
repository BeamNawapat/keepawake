#!/usr/bin/env node
import { check } from "./commands/check.js";
import { createCtx, parseFlags, type Ctx } from "./commands/common.js";
import { removeAuto, setupAuto, uninstall } from "./commands/autostart.js";
import { runMonitor } from "./commands/daemon.js";
import { doctor } from "./commands/doctor.js";
import { HELP } from "./commands/help.js";
import { log } from "./commands/log.js";
import { restart } from "./commands/restart.js";
import { start } from "./commands/start.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import { checkForUpdate, noticeLine, shouldCheck } from "./core/update-check.js";
import { VERSION } from "./version.js";

async function main(argv: string[]): Promise<number> {
  const [cmd = "help", ...rest] = argv;
  const ctx = createCtx();

  // Started before the command so the lookup overlaps with its work; it never throws.
  const wantNotice = shouldCheck(ctx.env, process.stdout.isTTY === true, cmd) && !rest.includes("--json");
  const latest = wantNotice
    ? checkForUpdate({ now: Date.now(), fetchImpl: fetch, cacheFile: ctx.paths.updateCheck, current: VERSION }).then(
        (r) => r.latest,
        () => null,
      )
    : Promise.resolve(null);
  const printNotice = async (): Promise<void> => {
    const line = noticeLine(VERSION, await latest);
    if (line) ctx.ui.dim(line);
  };
  // A foreground start never returns until Ctrl+C, so its notice goes right under the banner.
  let shown = false;
  ctx.onBanner = () => {
    shown = true;
    void printNotice();
  };

  const code = await run(cmd, rest, ctx);
  if (!shown) await printNotice();
  return code;
}

async function run(cmd: string, rest: string[], ctx: Ctx): Promise<number> {
  try {
    switch (cmd) {
      case "--version":
      case "-v":
      case "version":
        console.log(VERSION);
        return 0;
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(HELP);
        return 0;
      case "start": {
        const p = parseFlags(rest, ctx.env);
        return await start(ctx, p.options, p.daemon);
      }
      case "__daemon":
        return await runMonitor(ctx, "daemon");
      case "stop":
        return await stop(ctx);
      case "restart":
        return await restart(ctx, rest);
      case "status":
        return await status(ctx, { json: parseFlags(rest, ctx.env).json });
      case "check":
        return await check(ctx, { json: parseFlags(rest, ctx.env).json });
      case "log":
        return await log(ctx);
      case "doctor": {
        const p = parseFlags(rest, ctx.env);
        return await doctor(ctx, { fix: p.fix, json: p.json });
      }
      case "setup-auto":
        return await setupAuto(ctx, rest);
      case "remove-auto":
        return await removeAuto(ctx);
      case "uninstall":
        return await uninstall(ctx);
      default:
        ctx.ui.err(`Unknown command: ${cmd}`);
        ctx.ui.dim("see `keepawake help`");
        return 1;
    }
  } catch (e) {
    ctx.ui.err((e as Error).message);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
