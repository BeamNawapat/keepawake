import { readState } from "../core/state.js";
import { parseFlags, type Ctx } from "./common.js";
import { start } from "./start.js";
import { stop } from "./stop.js";

/** No flags given = reuse the options (and background/foreground mode) of the run being replaced. */
export async function restart(ctx: Ctx, argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, ctx.env);
  const saved = readState(ctx.paths.state);

  const options = parsed.optionFlagsGiven || !saved ? parsed.options : saved.options;
  const daemon = parsed.daemon || (!parsed.optionFlagsGiven && saved?.mode === "daemon");

  const code = await stop(ctx, { quiet: true });
  if (code !== 0) return code;
  return start(ctx, options, daemon);
}
