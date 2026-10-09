import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOptions } from "../src/core/config.js";
import { installCleanup } from "../src/core/lifecycle.js";
import { MAX_LOG_BYTES, createLogger } from "../src/core/logger.js";
import { resolvePaths } from "../src/core/paths.js";
import { clearState, readState, writeState, type State } from "../src/core/state.js";
import { createUi } from "../src/core/ui.js";

const root = mkdtempSync(join(tmpdir(), "keepawake-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sample = (): State => ({
  version: 1,
  pid: 123,
  startedAt: "2026-10-09T00:00:00.000Z",
  mode: "daemon",
  options: { ...defaultOptions(), lid: true, hotspot: "Beam" },
  holderPid: 124,
  lid: { kind: "darwin", sleepDisabled: "0" },
});

describe("paths", () => {
  test("KEEPAWAKE_HOME wins, default is ~/.keepawake", () => {
    expect(resolvePaths({ KEEPAWAKE_HOME: "/x/y" }, "/h").state).toBe(join("/x/y", "state.json"));
    expect(resolvePaths({}, "/h").dir).toBe(join("/h", ".keepawake"));
    expect(resolvePaths({}, "/h").logOld).toBe(join("/h", ".keepawake", "keepawake.log.old"));
  });
});

describe("state", () => {
  test("round-trips and leaves no temp file behind", () => {
    const dir = join(root, "rt");
    const file = join(dir, "state.json");
    writeState(file, sample());
    expect(readState(file)).toEqual(sample());
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  test("overwrite replaces the previous content", () => {
    const file = join(root, "ow", "state.json");
    writeState(file, sample());
    writeState(file, { ...sample(), pid: 999 });
    expect(readState(file)?.pid).toBe(999);
  });

  test("missing file is null", () => {
    expect(readState(join(root, "nope.json"))).toBeNull();
  });

  test("corrupt, truncated or wrong-version files are null", () => {
    const file = join(root, "bad.json");
    for (const content of ["", "{", "[]", "null", '{"version":2,"pid":1}', '{"version":1,"pid":"x"}']) {
      writeFileSync(file, content);
      expect(readState(file)).toBeNull();
    }
  });

  test("clearState tolerates a missing file", () => {
    const file = join(root, "gone.json");
    writeState(file, sample());
    clearState(file);
    expect(existsSync(file)).toBe(false);
    expect(() => clearState(file)).not.toThrow();
  });
});

describe("logger", () => {
  const fixed = () => new Date(2026, 9, 9, 7, 5, 3);

  test("prefixes lines with [HH:MM:SS]", () => {
    const file = join(root, "a", "keepawake.log");
    createLogger(file, { now: fixed }).log("daemon started");
    expect(readFileSync(file, "utf8")).toBe("[07:05:03] daemon started\n");
  });

  test("rotates to .old once the file exceeds 524288 bytes", () => {
    expect(MAX_LOG_BYTES).toBe(524288);
    const file = join(root, "b", "keepawake.log");
    const logger = createLogger(file, { now: fixed });
    logger.log("first");
    writeFileSync(file, "x".repeat(MAX_LOG_BYTES + 1));
    logger.log("after rotation");
    expect(statSync(`${file}.old`).size).toBe(MAX_LOG_BYTES + 1);
    expect(readFileSync(file, "utf8")).toBe("[07:05:03] after rotation\n");
  });

  test("exactly 524288 bytes does not rotate", () => {
    const file = join(root, "c", "keepawake.log");
    const logger = createLogger(file, { now: fixed });
    writeFileSync(file, "x".repeat(MAX_LOG_BYTES));
    logger.log("more");
    expect(existsSync(`${file}.old`)).toBe(false);
  });
});

describe("ui", () => {
  test("no ANSI codes when not a TTY or NO_COLOR is set", () => {
    const lines: string[] = [];
    const plain = createUi({ isTTY: false, noColor: false, out: (l) => lines.push(l), err: (l) => lines.push(l) });
    plain.info("ok");
    plain.warn("careful");
    plain.err("bad");
    createUi({ isTTY: true, noColor: true, out: (l) => lines.push(l), err: (l) => lines.push(l) }).dim("quiet");
    expect(lines).toEqual(["  ✔ ok", "  ⚠ careful", "  ✘ bad", "  quiet"]);
  });

  test("colors when TTY", () => {
    const lines: string[] = [];
    createUi({ isTTY: true, noColor: false, out: (l) => lines.push(l), err: () => {} }).info("ok");
    expect(lines[0]).toContain("\x1b[0;32m");
  });
});

describe("lifecycle", () => {
  test("cleanup runs once even when several triggers fire", async () => {
    const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    const exits: number[] = [];
    const fakeProc = {
      on: (ev: string, fn: (...a: unknown[]) => void) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
      off: (ev: string, fn: (...a: unknown[]) => void) =>
        void handlers.set(ev, (handlers.get(ev) ?? []).filter((f) => f !== fn)),
      exit: (c: number) => void exits.push(c),
      stderr: { write: () => true },
    } as unknown as NodeJS.Process;

    let runs = 0;
    const dispose = installCleanup(async () => void runs++, fakeProc);
    handlers.get("SIGINT")![0]!();
    handlers.get("SIGTERM")![0]!();
    handlers.get("exit")![0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toBe(1);
    expect(exits).toEqual([0, 0]);

    dispose();
    expect(handlers.get("SIGINT")).toEqual([]);
  });
});
