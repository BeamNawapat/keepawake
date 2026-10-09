import { AGENTS } from "../core/agents.js";
import { parseIgnore } from "../core/config.js";
import { detectAgents } from "../core/detector.js";
import { parseSleepDisabled } from "../platform/darwin/lid.js";
import { reconcile, type Ctx } from "./common.js";

export async function status(ctx: Ctx, opts: { json: boolean }): Promise<number> {
  const { ui } = ctx;
  const platform = ctx.makePlatform(false);

  // restoreLid:false keeps status from prompting for sudo; doctor --fix handles that case.
  const rec = await reconcile(ctx, platform, { restoreLid: false });
  const state = rec.kind === "alive" ? rec.state : null;

  const agents = detectAgents(await platform.processes.list(), AGENTS, {
    selfPids: [process.pid, process.ppid],
    ignore: parseIgnore(ctx.env),
  });
  const online = await platform.network.isOnline();
  let sleepDisabled: boolean | null = null;
  if (process.platform === "darwin") {
    const r = await ctx.exec.run("pmset", ["-g"], { timeoutMs: 5000 });
    if (r.code === 0) sleepDisabled = parseSleepDisabled(r.stdout) === "1";
  }

  if (opts.json) {
    ui.line(
      JSON.stringify({
        running: state !== null,
        stale: rec.kind === "blocked",
        pid: state?.pid ?? null,
        mode: state?.mode ?? null,
        startedAt: state?.startedAt ?? null,
        options: state?.options ?? null,
        holderPid: state?.holderPid ?? null,
        awake: state?.holderPid != null,
        lid: state?.lid ?? null,
        agents: agents.map((a) => ({ id: a.id, label: a.label, kind: a.kind })),
        online,
        sleepDisabled,
      }),
    );
    return 0;
  }

  ui.header("keepawake status");
  if (state) {
    ui.info(`Daemon:     ${ui.paint.green("running")} (PID ${state.pid}, ${state.mode})`);
    ui.info(`Mode:       ${state.options.always ? "always-on" : "follows agents"}`);
    if (state.options.lid) ui.info(`Lid mode:   ${ui.paint.yellow("ON")}`);
    else ui.dim("Lid mode:   off");
    if (state.options.hotspot) ui.info(`Hotspot:    ${ui.paint.yellow(state.options.hotspot)}`);
    else ui.dim("Hotspot:    off");
    if (state.holderPid !== null) ui.info(`Holder:     ${ui.paint.green("active")} (PID ${state.holderPid})`);
    else ui.dim("Holder:     inactive");
  } else if (rec.kind === "blocked") {
    ui.warn("Daemon:     dead, but it left the lid setting changed. Run `keepawake doctor --fix`");
  } else {
    ui.dim("Daemon:     not running");
  }

  if (agents.length > 0) ui.info(`Agents:     ${ui.paint.green(agents.map((a) => a.label).join(", "))}`);
  else ui.dim("Agents:     none detected");

  if (online) ui.info(`Internet:   ${ui.paint.green("connected")}`);
  else ui.warn(`Internet:   ${ui.paint.red("no connection")}`);

  if (sleepDisabled === true) ui.warn("System:     sleep disabled");
  else if (sleepDisabled === false) ui.dim("System:     normal sleep");
  ui.line("");
  return 0;
}
