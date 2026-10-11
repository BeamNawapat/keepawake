import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "../src/core/paths.js";
import {
  CACHE_TTL_MS,
  checkForUpdate,
  compareSemver,
  noticeLine,
  readCache,
  shouldCheck,
} from "../src/core/update-check.js";

const root = mkdtempSync(join(tmpdir(), "keepawake-upd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function fakeFetch(version: string | Error) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    if (version instanceof Error) throw version;
    return new Response(JSON.stringify({ version }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function home(name: string) {
  // Same resolution the CLI uses, so the cache path field is covered too.
  return resolvePaths({ KEEPAWAKE_HOME: join(root, name) }, "/unused").updateCheck;
}

describe("compareSemver", () => {
  test("numeric, not lexical", () => {
    expect(compareSemver("0.1.10", "0.1.9")).toBe(1);
    expect(compareSemver("0.1.9", "0.1.10")).toBe(-1);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.2.0", "0.1.99")).toBe(1);
    expect(compareSemver("0.1.1", "0.1.1")).toBe(0);
  });
  test("a prerelease is lower than its release", () => {
    expect(compareSemver("0.2.0-beta.1", "0.2.0")).toBe(-1);
    expect(compareSemver("0.2.0", "0.2.0-beta.1")).toBe(1);
    expect(compareSemver("0.2.0-beta.1", "0.1.9")).toBe(1);
  });
  test("garbage compares equal", () => {
    expect(compareSemver("dev", "0.1.1")).toBe(0);
  });
});

describe("shouldCheck", () => {
  test("allowed on a TTY for a user command", () => {
    expect(shouldCheck({}, true, "status")).toBe(true);
  });
  test("gates", () => {
    expect(shouldCheck({ CI: "true" }, true, "status")).toBe(false);
    expect(shouldCheck({ KEEPAWAKE_NO_UPDATE_CHECK: "1" }, true, "status")).toBe(false);
    expect(shouldCheck({ NO_UPDATE_NOTIFIER: "1" }, true, "status")).toBe(false);
    expect(shouldCheck({}, false, "status")).toBe(false);
    expect(shouldCheck({}, true, "__daemon")).toBe(false);
    expect(shouldCheck({}, true, "log")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  test("fresh cache: no fetch", async () => {
    const cacheFile = home("fresh");
    const f = fakeFetch("9.9.9");
    await checkForUpdate({ now: NOW - 1000, fetchImpl: fakeFetch("0.2.0").impl, cacheFile, current: "0.1.1" });
    const r = await checkForUpdate({ now: NOW + CACHE_TTL_MS - 2000, fetchImpl: f.impl, cacheFile, current: "0.1.1" });
    expect(f.calls).toHaveLength(0);
    expect(r).toEqual({ latest: "0.2.0", fromCache: true });
  });

  test("stale cache: fetches and rewrites", async () => {
    const cacheFile = home("stale");
    await checkForUpdate({ now: NOW - CACHE_TTL_MS - 1, fetchImpl: fakeFetch("0.1.5").impl, cacheFile, current: "0.1.1" });
    const f = fakeFetch("0.2.0");
    const r = await checkForUpdate({ now: NOW, fetchImpl: f.impl, cacheFile, current: "0.1.1" });
    expect(f.calls).toEqual(["https://registry.npmjs.org/@beamnawapat%2Fkeepawake/latest"]);
    expect(r).toEqual({ latest: "0.2.0", fromCache: false });
    expect(readCache(cacheFile)).toEqual({ checkedAt: iso(NOW), latest: "0.2.0" });
  });

  test("fetch error: checkedAt bumped, latest kept, no throw", async () => {
    const cacheFile = home("err");
    await checkForUpdate({ now: NOW - CACHE_TTL_MS - 1, fetchImpl: fakeFetch("0.2.0").impl, cacheFile, current: "0.1.1" });
    const r = await checkForUpdate({ now: NOW, fetchImpl: fakeFetch(new Error("offline")).impl, cacheFile, current: "0.1.1" });
    expect(r).toEqual({ latest: "0.2.0", fromCache: false });
    expect(readCache(cacheFile)).toEqual({ checkedAt: iso(NOW), latest: "0.2.0" });
    // and the bump stops the retry on the next command
    const f = fakeFetch("0.3.0");
    await checkForUpdate({ now: NOW + 1000, fetchImpl: f.impl, cacheFile, current: "0.1.1" });
    expect(f.calls).toHaveLength(0);
  });

  test("fetch error with no cache: file written, nothing to report", async () => {
    const cacheFile = home("nocache");
    const r = await checkForUpdate({ now: NOW, fetchImpl: fakeFetch(new Error("offline")).impl, cacheFile, current: "0.1.1" });
    expect(r.latest).toBeNull();
    expect(existsSync(cacheFile)).toBe(true);
    expect(readCache(cacheFile)).toEqual({ checkedAt: iso(NOW), latest: "" });
  });

  test("corrupt cache is treated as missing", async () => {
    const cacheFile = home("corrupt");
    await checkForUpdate({ now: NOW, fetchImpl: fakeFetch(new Error("x")).impl, cacheFile, current: "0.1.1" });
    writeFileSync(cacheFile, "{nope");
    const f = fakeFetch("0.2.0");
    const r = await checkForUpdate({ now: NOW, fetchImpl: f.impl, cacheFile, current: "0.1.1" });
    expect(f.calls).toHaveLength(1);
    expect(r.latest).toBe("0.2.0");
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).latest).toBe("0.2.0");
  });
});

describe("noticeLine", () => {
  test("prints only when newer", () => {
    expect(noticeLine("0.1.1", "0.2.0")).toBe("↑ update available: 0.1.1 -> 0.2.0   npm i -g @beamnawapat/keepawake");
    expect(noticeLine("0.1.1", "0.1.1")).toBeNull();
    expect(noticeLine("0.1.1", "0.1.0")).toBeNull();
    expect(noticeLine("0.1.1", null)).toBeNull();
    expect(noticeLine("dev", "9.9.9")).toBeNull();
  });
});
