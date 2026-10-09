import { parseSleepDisabled } from "../platform/darwin/lid.js";
import { readState } from "../core/state.js";
import { reconcile, type Ctx } from "./common.js";

interface Finding {
  level: "ok" | "warn";
  message: string;
}

export async function doctor(ctx: Ctx, opts: { fix: boolean; json: boolean }): Promise<number> {
  const { ui, paths } = ctx;
  const platform = ctx.makePlatform(false);
  const findings: Finding[] = [];
  const add = (level: Finding["level"], message: string) => findings.push({ level, message });

  const before = readState(paths.state);
  const rec = await reconcile(ctx, platform, { restoreLid: opts.fix });
  if (rec.kind === "none") add("ok", "no state file, nothing running");
  else if (rec.kind === "alive") add("ok", `daemon running (PID ${rec.state.pid})`);
  else if (rec.kind === "cleaned") add("ok", "stale state found and cleaned (holder released, lid setting restored)");
  else add("warn", "stale state with a changed lid setting; run `keepawake doctor --fix`");

  // The holder outliving a live daemon is not possible by design, so only check the dead-daemon case above.
  if (before && before.holderPid !== null && rec.kind === "blocked") {
    add("warn", `holder PID ${before.holderPid} may still be running`);
  }

  if (process.platform === "darwin") {
    const r = await ctx.exec.run("pmset", ["-g"], { timeoutMs: 5000 });
    const disabled = r.code === 0 && parseSleepDisabled(r.stdout) === "1";
    const owned = readState(paths.state)?.lid != null;
    if (disabled && !owned) {
      add("warn", "SleepDisabled is 1 but keepawake does not hold it. If you did not set it yourself: sudo pmset -a disablesleep 0");
    } else {
      add("ok", disabled ? "SleepDisabled is 1 and owned by keepawake" : "SleepDisabled is 0");
    }
  }

  try {
    add("ok", (await platform.autostart.isInstalled()) ? "auto-start installed" : "auto-start not installed");
  } catch (e) {
    add("warn", `auto-start check failed: ${(e as Error).message}`);
  }

  if (opts.json) ui.line(JSON.stringify({ findings }));
  else {
    ui.header("keepawake doctor");
    for (const f of findings) (f.level === "ok" ? ui.info : ui.warn)(f.message);
    ui.line("");
  }
  return findings.some((f) => f.level === "warn") ? 1 : 0;
}
