import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optionsToFlags, parseFlags, reconcile, type Ctx } from "../src/commands/common.js";
import { acquireStartLock, start } from "../src/commands/start.js";
import { HELP } from "../src/commands/help.js";
import { resolvePaths } from "../src/core/paths.js";
import { readState, writeState, type State } from "../src/core/state.js";
import { createUi } from "../src/core/ui.js";
import { matchesArgv, type Platform } from "../src/platform/index.js";
import { fakeExec } from "./fake-exec.js";

describe("parseFlags", () => {
  test("defaults", () => {
    const p = parseFlags([], {});
    expect(p.options).toEqual({ always: false, for: null, lid: false, display: false, hotspot: null, interval: 15, apps: true });
    expect(p.daemon).toBe(false);
    expect(p.optionFlagsGiven).toBe(false);
  });

  test("all flags", () => {
    const p = parseFlags(["-a", "--for", "2h", "--lid", "--display", "--hotspot", "Beam", "--interval", "5", "--no-apps", "-d"], {});
    expect(p.options).toEqual({ always: true, for: 7200, lid: true, display: true, hotspot: "Beam", interval: 5, apps: false });
    expect(p.daemon).toBe(true);
    expect(p.optionFlagsGiven).toBe(true);
  });

  test("--background and --daemon both detach; -d alone is not an option flag", () => {
    expect(parseFlags(["--background"], {}).daemon).toBe(true);
    expect(parseFlags(["-d"], {}).optionFlagsGiven).toBe(false);
  });

  test("--for needs --always", () => {
    expect(() => parseFlags(["--for", "1h"], {})).toThrow(/--always/);
  });

  test("rejects bad values and unknown flags", () => {
    expect(() => parseFlags(["--interval", "0"], {})).toThrow();
    expect(() => parseFlags(["-a", "--for", "soon"], {})).toThrow();
    expect(() => parseFlags(["--hotspot", " "], {})).toThrow(/Wi-Fi name/);
    expect(() => parseFlags(["--nope"], {})).toThrow();
  });

  test("KEEPAWAKE_INTERVAL is used when no flag is given", () => {
    expect(parseFlags([], { KEEPAWAKE_INTERVAL: "30" }).options.interval).toBe(30);
  });

  test("optionsToFlags round-trips", () => {
    const first = parseFlags(["-a", "--for", "90m", "--display", "--hotspot", "My Phone", "--no-apps"], {}).options;
    expect(parseFlags(optionsToFlags(first), {}).options).toEqual(first);
  });
});

test("help text lists every command and flag", () => {
  for (const w of ["start", "stop", "restart", "status", "check", "log", "doctor", "setup-auto", "remove-auto", "uninstall", "--always", "--for", "--lid", "--display", "--hotspot", "--interval", "--no-apps", "--background"]) {
    expect(HELP).toContain(w);
  }
});

describe("reconcile", () => {
  function setup(state: State | null, alive: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "kw-cli-"));
    const paths = resolvePaths({ KEEPAWAKE_HOME: dir }, dir);
    if (state) writeState(paths.state, state);
    writeFileSync(paths.pid, "1");
    const released: Array<{ pid: number; ownerPid: number }> = [];
    const aliveCalls: unknown[] = [];
    const restored: unknown[] = [];
    const platform = {
      isAlive: async (_pid: number, expect: unknown) => (aliveCalls.push(expect), alive),
      power: { release: async (h: { pid: number; ownerPid: number }) => (released.push(h), true) },
      lid: {
        restore: async (s: unknown) => void restored.push(s),
      },
    } as unknown as Platform;
    const ctx: Ctx = {
      exec: fakeExec(),
      paths,
      ui: createUi({ out: () => {}, err: () => {}, isTTY: false }),
      env: {},
      makePlatform: () => platform,
    };
    return { ctx, platform, released, restored, paths, aliveCalls };
  }
  const base: State = {
    version: 1,
    pid: 999999,
    startedAt: "2026-01-01T00:00:00Z",
    mode: "daemon",
    cli: "/opt/keepawake/dist/cli.js",
    options: parseFlags([], {}).options,
    holderPid: 4242,
    lid: { kind: "darwin", sleepDisabled: "0" },
  };

  test("no state", async () => {
    const t = setup(null, false);
    expect((await reconcile(t.ctx, t.platform, { restoreLid: true })).kind).toBe("none");
  });

  test("live daemon is left alone", async () => {
    const t = setup(base, true);
    expect((await reconcile(t.ctx, t.platform, { restoreLid: true })).kind).toBe("alive");
    expect(t.released).toEqual([]);
  });

  test("dead daemon: holder released, lid restored, files cleared", async () => {
    const t = setup(base, false);
    expect((await reconcile(t.ctx, t.platform, { restoreLid: true })).kind).toBe("cleaned");
    expect(t.released).toEqual([{ pid: 4242, ownerPid: 999999 }]);
    expect(t.aliveCalls).toEqual([{ mode: "daemon", cli: "/opt/keepawake/dist/cli.js" }]);
    expect(t.restored).toEqual([{ kind: "darwin", sleepDisabled: "0" }]);
    expect(readState(t.paths.state)).toBeNull();
  });

  test("read-only callers do not touch a stale lid snapshot", async () => {
    const t = setup(base, false);
    expect((await reconcile(t.ctx, t.platform, { restoreLid: false })).kind).toBe("blocked");
    expect(t.restored).toEqual([]);
    expect(readState(t.paths.state)).not.toBeNull();
  });
});

describe("isAlive argv matching", () => {
  const cli = "/opt/keepawake/dist/cli.js";
  test("daemon mode needs __daemon and the cli path", () => {
    const d = { mode: "daemon", cli } as const;
    expect(matchesArgv(`node ${cli} __daemon`, d)).toBe(true);
    expect(matchesArgv(`node ${cli} start -d`, d)).toBe(false);
    expect(matchesArgv("node /usr/lib/npm/bin/npm-cli.js __daemon", d)).toBe(false);
    expect(matchesArgv("node /usr/lib/npm/bin/npm-cli.js install", d)).toBe(false);
  });

  test("foreground mode needs the cli path and ' start'", () => {
    const f = { mode: "foreground", cli } as const;
    expect(matchesArgv(`node ${cli} start --always`, f)).toBe(true);
    expect(matchesArgv(`node ${cli} __daemon`, f)).toBe(false);
    expect(matchesArgv("node /usr/lib/npm/bin/npm-cli.js start", f)).toBe(false);
  });

  test("unknown argv is not ours", () => {
    expect(matchesArgv(undefined, { mode: "daemon", cli })).toBe(false);
    expect(matchesArgv(undefined, { mode: "foreground", cli })).toBe(false);
  });
});

describe("start lock and ordering", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "kw-start-"));
    const paths = resolvePaths({ KEEPAWAKE_HOME: dir }, dir);
    const events: string[] = [];
    let stateAtSet: State | null = null;
    const platform = {
      isAlive: async () => false,
      privilege: { isElevated: async () => true },
      power: { release: async () => true },
      lid: {
        snapshot: async () => (events.push("snapshot"), { kind: "darwin", sleepDisabled: "0" }),
        set: async () => {
          events.push("set");
          stateAtSet = readState(paths.state);
          await new Promise((r) => setTimeout(r, 30));
          throw new Error("sudo denied");
        },
        restore: async () => void events.push("restore"),
      },
    } as unknown as Platform;
    const ctx: Ctx = {
      exec: fakeExec(),
      paths,
      ui: createUi({ out: () => {}, err: () => {}, isTTY: false }),
      env: {},
      makePlatform: () => platform,
    };
    return { ctx, paths, events, stateAtSet: () => stateAtSet };
  }
  const lidOptions = () => parseFlags(["--lid"], {}).options;

  test("lock is exclusive, released, and a dead owner's lock is taken over", () => {
    const dir = mkdtempSync(join(tmpdir(), "kw-lock-"));
    const paths = resolvePaths({ KEEPAWAKE_HOME: dir }, dir);
    const first = acquireStartLock(paths);
    expect(first).not.toBeNull();
    expect(acquireStartLock(paths)).toBeNull();
    first!();
    expect(existsSync(paths.lock)).toBe(false);

    writeFileSync(paths.lock, "2147483646"); // no such pid
    const again = acquireStartLock(paths);
    expect(again).not.toBeNull();
    again!();
  });

  test("two concurrent starts: the second is refused while the first runs", async () => {
    const t = setup();
    const a = start(t.ctx, lidOptions(), true);
    const b = start(t.ctx, lidOptions(), true);
    expect(await b).toBe(1);
    expect(await a).toBe(1); // A fails on purpose (set throws)
    expect(t.events.filter((e) => e === "snapshot")).toHaveLength(1); // B never reached the lid
    expect(existsSync(t.paths.lock)).toBe(false);
  });

  test("snapshot is in state.json before set(); a failing set() restores and clears", async () => {
    const t = setup();
    expect(await start(t.ctx, lidOptions(), true)).toBe(1);
    expect(t.events).toEqual(["snapshot", "set", "restore"]);
    expect(t.stateAtSet()?.lid).toEqual({ kind: "darwin", sleepDisabled: "0" });
    expect(readState(t.paths.state)).toBeNull();
    expect(existsSync(t.paths.lock)).toBe(false);
  });
});
