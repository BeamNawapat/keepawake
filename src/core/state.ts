import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Options } from "./config.js";
import type { LidSnapshot } from "../ports/lid.js";

export interface State {
  version: 1;
  pid: number;
  startedAt: string;
  mode: "foreground" | "daemon";
  /** realpath of the cli entry that wrote this state; isAlive matches it against the process argv. */
  cli: string;
  options: Options;
  holderPid: number | null;
  lid: LidSnapshot | null;
}

/** A missing, unreadable or malformed file all mean "no state". */
export function readState(file: string): State | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isState(parsed)) return null;
  return parsed;
}

function isState(v: unknown): v is State {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    s.version === 1 &&
    Number.isInteger(s.pid) &&
    // State from older versions has no cli; treating it as absent lets reconcile handle it as stale.
    typeof s.cli === "string" &&
    (s.holderPid === null || (Number.isInteger(s.holderPid) && (s.holderPid as number) > 0)) &&
    typeof s.startedAt === "string" &&
    (s.mode === "foreground" || s.mode === "daemon") &&
    typeof s.options === "object" &&
    s.options !== null
  );
}

/**
 * Write to a temp file in the same directory, then rename. A crash mid-write
 * leaves the old file intact instead of a half-written snapshot that would
 * lose the lid restore value.
 */
export function writeState(file: string, state: State): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // temp file already gone
    }
    throw e;
  }
}

export function clearState(file: string): void {
  try {
    unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
