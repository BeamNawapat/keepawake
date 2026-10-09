import { AGENTS } from "../core/agents.js";
import { parseIgnore } from "../core/config.js";
import { detectAgents } from "../core/detector.js";
import type { Ctx } from "./common.js";

export async function check(ctx: Ctx, opts: { json: boolean }): Promise<number> {
  const platform = ctx.makePlatform(false);
  const found = detectAgents(await platform.processes.list(), AGENTS, {
    selfPids: [process.pid, process.ppid],
    ignore: parseIgnore(ctx.env),
  });
  if (opts.json) {
    ctx.ui.line(JSON.stringify({ found: found.length > 0, agents: found.map((a) => ({ id: a.id, label: a.label, kind: a.kind })) }));
  } else if (found.length > 0) {
    ctx.ui.info(`Detected: ${found.map((a) => a.label).join(", ")}`);
  } else {
    ctx.ui.dim("No agent detected");
  }
  return found.length > 0 ? 0 : 1;
}
