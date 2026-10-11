import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GLYPH } from "./ui.js";

export const PACKAGE = "@beamnawapat/keepawake";
const REGISTRY_URL = "https://registry.npmjs.org/@beamnawapat%2Fkeepawake/latest";
export const CACHE_TTL_MS = 30 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 1500;

/** Commands a person types. Everything else (__daemon, log, setup-auto...) stays quiet. */
const NOTICE_COMMANDS = new Set([
  "start", "status", "check", "doctor", "help", "--help", "-h", "version", "--version", "-v", "stop", "restart",
]);

export interface Cache {
  checkedAt: string;
  /** Empty when no check has ever succeeded. */
  latest: string;
}

export function shouldCheck(env: NodeJS.ProcessEnv, isTTY: boolean, cmd: string = "start"): boolean {
  if (!isTTY || !NOTICE_COMMANDS.has(cmd)) return false;
  return env.KEEPAWAKE_NO_UPDATE_CHECK !== "1" && env.CI !== "true" && env.NO_UPDATE_NOTIFIER !== "1";
}

function parse(v: string): { nums: [number, number, number]; pre: boolean } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[^+]*)?(\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== undefined };
}

/** 1 when a > b, -1 when a < b, 0 when equal or either side is not a version. A prerelease sorts below its release. */
export function compareSemver(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    const d = x.nums[i]! - y.nums[i]!;
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  return x.pre ? -1 : 1;
}

export function readCache(file: string): Cache | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Cache>;
    if (typeof raw.checkedAt !== "string" || typeof raw.latest !== "string") return null;
    if (Number.isNaN(Date.parse(raw.checkedAt))) return null;
    return { checkedAt: raw.checkedAt, latest: raw.latest };
  } catch {
    return null;
  }
}

export function writeCache(file: string, cache: Cache): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, file);
}

export interface CheckOptions {
  now: number;
  fetchImpl: typeof fetch;
  cacheFile: string;
  current: string;
}

/** Never throws. A failed fetch only moves checkedAt forward so a dead network is not retried on every command. */
export async function checkForUpdate(o: CheckOptions): Promise<{ latest: string | null; fromCache: boolean }> {
  const cached = readCache(o.cacheFile);
  const known = cached && cached.latest !== "" ? cached.latest : null;
  if (cached && o.now - Date.parse(cached.checkedAt) < CACHE_TTL_MS && o.now >= Date.parse(cached.checkedAt)) {
    return { latest: known, fromCache: true };
  }
  const checkedAt = new Date(o.now).toISOString();
  try {
    const res = await o.fetchImpl(REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string" || !parse(body.version)) throw new Error("no version in response");
    save(o.cacheFile, { checkedAt, latest: body.version });
    return { latest: body.version, fromCache: false };
  } catch {
    save(o.cacheFile, { checkedAt, latest: known ?? "" });
    return { latest: known, fromCache: false };
  }
}

function save(file: string, cache: Cache): void {
  try {
    writeCache(file, cache);
  } catch {
    // read-only home: the notice is optional
  }
}

/** The one-line notice, or null when there is nothing newer (or this is a dev build). */
export function noticeLine(current: string, latest: string | null): string | null {
  if (latest === null || current === "dev" || compareSemver(latest, current) <= 0) return null;
  return `${GLYPH.up} update available: ${current} -> ${latest}   npm i -g ${PACKAGE}`;
}
