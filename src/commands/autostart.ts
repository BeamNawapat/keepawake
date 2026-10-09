import { realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { parseFlags, optionsToFlags, type Ctx } from "./common.js";
import { stop } from "./stop.js";

export async function setupAuto(ctx: Ctx, argv: string[]): Promise<number> {
  const { ui } = ctx;
  const { options } = parseFlags(argv, ctx.env);
  if (options.lid) {
    ui.err("setup-auto does not accept --lid");
    ui.dim("--lid needs an admin prompt (sudo or UAC) every time it starts and stops, and a login item has no terminal to answer it.");
    ui.dim("Start with `keepawake start --lid` yourself when you need it.");
    return 1;
  }
  const platform = ctx.makePlatform(false);
  const flags = optionsToFlags(options);
  const cli = realpathSync(process.argv[1] ?? "");
  // The darwin adapter prepends [node, cli, start] itself; the others take the full argv.
  const args = process.platform === "darwin" ? flags : [process.execPath, cli, "start", ...flags];
  try {
    const { path } = await platform.autostart.install(args);
    ui.info("Auto-start on login installed");
    ui.dim(path);
    ui.dim("The node path is stored as-is. If you switch node versions (nvm, volta), run setup-auto again.");
    return 0;
  } catch (e) {
    ui.err((e as Error).message);
    return 1;
  }
}

export async function removeAuto(ctx: Ctx): Promise<number> {
  const removed = await ctx.makePlatform(false).autostart.remove();
  if (removed) ctx.ui.info("Auto-start removed");
  else ctx.ui.dim("No auto-start entry found");
  return 0;
}

export async function uninstall(ctx: Ctx): Promise<number> {
  const { ui, paths } = ctx;
  ui.header("Uninstalling keepawake");
  const code = await stop(ctx);
  if (code !== 0) return code;
  await removeAuto(ctx);
  // Only the files we create; a stray file in the directory is the user's.
  for (const f of [paths.pid, paths.state, paths.log, paths.logOld]) {
    try {
      unlinkSync(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  try {
    rmdirSync(paths.dir);
  } catch {
    // missing or not empty
  }
  ui.info("Local data removed");
  ui.dim("Remove the program itself with: npm rm -g keepawake");
  return 0;
}
