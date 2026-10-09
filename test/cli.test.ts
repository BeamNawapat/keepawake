import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optionsToFlags, parseFlags, reconcile, type Ctx } from "../src/commands/common.js";
import { HELP } from "../src/commands/help.js";
import { resolvePaths } from "../src/core/paths.js";
import { readState, writeState, type State } from "../src/core/state.js";
import { createUi } from "../src/core/ui.js";
import type { Platform } from "../src/platform/index.js";
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
    const released: number[] = [];
    const restored: unknown[] = [];
    const platform = {
      isAlive: async () => alive,
      power: { release: async (h: { pid: number }) => void released.push(h.pid) },
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
    return { ctx, platform, released, restored, paths };
  }
  const base: State = {
    version: 1,
    pid: 999999,
    startedAt: "2026-01-01T00:00:00Z",
    mode: "daemon",
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
    expect(t.released).toEqual([4242]);
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
