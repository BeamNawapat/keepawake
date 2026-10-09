import { describe, expect, test } from "bun:test";
import { parseDuration, parseIgnore, resolveInterval } from "../src/core/config.js";
import { initialState, step, type MonitorConfig, type MonitorState, type Observation } from "../src/core/monitor.js";
import { abortableSleep, runLoop } from "../src/core/runner.js";

const cfg = (over: Partial<MonitorConfig> = {}): MonitorConfig => ({ always: false, hotspot: null, expiresAt: null, ...over });
const obs = (over: Partial<Observation> = {}): Observation => ({ agents: [], online: null, now: 0, ...over });

describe("monitor reducer", () => {
  test("idle with no agents does nothing", () => {
    expect(step(initialState, obs(), cfg())).toEqual({ state: initialState, effects: [] });
  });

  test("agent appears then disappears", () => {
    const a = step(initialState, obs({ agents: ["Claude Code"] }), cfg());
    expect(a.effects).toEqual([{ type: "acquire", reason: "agents", agents: ["Claude Code"] }]);
    expect(a.state.awake).toBe(true);

    const same = step(a.state, obs({ agents: ["Claude Code"] }), cfg());
    expect(same.effects).toEqual([]);

    const b = step(a.state, obs(), cfg());
    expect(b.effects).toEqual([{ type: "release", reason: "agents-gone" }]);
    expect(b.state.awake).toBe(false);
  });

  test("always mode acquires immediately and ignores missing agents", () => {
    const a = step(initialState, obs(), cfg({ always: true }));
    expect(a.effects).toEqual([{ type: "acquire", reason: "always", agents: [] }]);
    expect(step(a.state, obs(), cfg({ always: true })).effects).toEqual([]);
  });

  test("--for expiry releases and expires, then stays quiet", () => {
    const c = cfg({ always: true, expiresAt: 1000 });
    const a = step(initialState, obs({ now: 0 }), c);
    const b = step(a.state, obs({ now: 1000 }), c);
    expect(b.effects).toEqual([{ type: "release", reason: "expired" }, { type: "expire" }]);
    expect(b.state.expired).toBe(true);
    expect(step(b.state, obs({ now: 2000 }), c).effects).toEqual([]);
  });

  test("expiry before anything was acquired only expires", () => {
    const b = step(initialState, obs({ now: 5 }), cfg({ always: true, expiresAt: 5 }));
    expect(b.effects).toEqual([{ type: "expire" }]);
  });

  describe("hotspot", () => {
    const c = cfg({ always: true, hotspot: "Beam" });
    const run = (s: MonitorState, o: Partial<Observation>) => step(s, obs({ online: true, ...o }), c);

    test("offline while awake retries every tick, flags the first attempt", () => {
      const s0 = run(initialState, {}).state; // acquires, online
      const s1 = run(s0, { online: false });
      expect(s1.effects).toEqual([{ type: "connect-hotspot", ssid: "Beam", firstAttempt: true }]);
      expect(s1.state.hotspot).toBe("connecting");
      const s2 = run(s1.state, { online: false });
      expect(s2.effects).toEqual([{ type: "connect-hotspot", ssid: "Beam", firstAttempt: false }]);
    });

    test("online again after an attempt reports restored once", () => {
      const down = run(run(initialState, {}).state, { online: false }).state;
      const up = run(down, { online: true });
      expect(up.effects).toEqual([{ type: "hotspot-restored", ssid: "Beam" }]);
      expect(up.state.hotspot).toBe("connected");
      expect(run(up.state, { online: true }).effects).toEqual([]);
    });

    test("never connects while not awake", () => {
      const r = step(initialState, obs({ online: false }), cfg({ hotspot: "Beam" }));
      expect(r.effects).toEqual([]);
    });

    test("releasing resets the hotspot phase", () => {
      const c2 = cfg({ hotspot: "Beam" });
      let s = step(initialState, obs({ agents: ["x"], online: false }), c2).state;
      expect(s.hotspot).toBe("connecting");
      s = step(s, obs({ agents: [], online: false }), c2).state;
      expect(s.hotspot).toBe("idle");
    });
  });
});

describe("duration, interval, ignore parsing", () => {
  test("durations", () => {
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("90m")).toBe(5400);
    expect(parseDuration("45s")).toBe(45);
    expect(parseDuration("3600")).toBe(3600);
    expect(parseDuration("1.5h")).toBe(5400);
  });

  test("bad durations throw", () => {
    for (const bad of ["", "abc", "-5", "0", "0m", "5x", "h"]) expect(() => parseDuration(bad)).toThrow();
  });

  test("interval precedence: flag, env, default", () => {
    expect(resolveInterval("30", { KEEPAWAKE_INTERVAL: "5" })).toBe(30);
    expect(resolveInterval(undefined, { KEEPAWAKE_INTERVAL: "5" })).toBe(5);
    expect(resolveInterval(undefined, {})).toBe(15);
    expect(() => resolveInterval("0", {})).toThrow();
    expect(() => resolveInterval("1.5", {})).toThrow();
  });

  test("ignore list", () => {
    expect(parseIgnore({ KEEPAWAKE_IGNORE: " Cursor, kiro ,," })).toEqual(["cursor", "kiro"]);
    expect(parseIgnore({})).toEqual([]);
  });
});

describe("runner", () => {
  test("abortableSleep returns promptly on abort", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = abortableSleep(60_000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await p;
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("abortableSleep returns at once when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await abortableSleep(60_000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  test("loop executes effects, stops on abort, sleeps the configured interval", async () => {
    const ac = new AbortController();
    const effects: string[] = [];
    const sleeps: number[] = [];
    let tick = 0;
    const final = await runLoop({
      config: cfg(),
      intervalMs: 15000,
      signal: ac.signal,
      observe: async () => ({ agents: tick++ < 2 ? ["Claude Code"] : [], online: null }),
      execute: async (e) => void effects.push(e.type),
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) ac.abort();
      },
    });
    expect(effects).toEqual(["acquire", "release"]);
    expect(sleeps).toEqual([15000, 15000, 15000]);
    expect(final.awake).toBe(false);
  });

  test("loop ends by itself when --for expires", async () => {
    const ac = new AbortController();
    let now = 0;
    const effects: string[] = [];
    const final = await runLoop({
      config: cfg({ always: true, expiresAt: 20_000 }),
      intervalMs: 15000,
      signal: ac.signal,
      now: () => now,
      observe: async () => ({ agents: [], online: null }),
      execute: async (e) => void effects.push(e.type),
      sleep: async (ms) => void (now += ms),
    });
    expect(effects).toEqual(["acquire", "release", "expire"]);
    expect(final.expired).toBe(true);
  });

  test("onError keeps the loop alive; without it the error propagates", async () => {
    const ac = new AbortController();
    const errors: unknown[] = [];
    let n = 0;
    await runLoop({
      config: cfg(),
      intervalMs: 1,
      signal: ac.signal,
      observe: async () => {
        if (n++ === 0) throw new Error("ps failed");
        ac.abort();
        return { agents: [], online: null };
      },
      execute: async () => {},
      onError: (e) => errors.push(e),
      sleep: async () => {},
    });
    expect(errors.length).toBe(1);

    await expect(
      runLoop({
        config: cfg(),
        intervalMs: 1,
        signal: new AbortController().signal,
        observe: async () => {
          throw new Error("boom");
        },
        execute: async () => {},
      }),
    ).rejects.toThrow("boom");
  });
});
