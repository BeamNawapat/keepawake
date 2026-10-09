import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_LOG_BYTES = 524288;

export interface Logger {
  log(message: string): void;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Append-only log with one generation of rotation. Callers pass agent labels
 * and event names only; full command lines can carry secrets and must not
 * reach this file.
 */
export function createLogger(file: string, opts: { maxBytes?: number; now?: () => Date } = {}): Logger {
  const maxBytes = opts.maxBytes ?? MAX_LOG_BYTES;
  const now = opts.now ?? (() => new Date());
  mkdirSync(dirname(file), { recursive: true });

  return {
    log(message) {
      rotateIfNeeded(file, maxBytes);
      const d = now();
      appendFileSync(file, `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${message}\n`, "utf8");
    },
  };
}

function rotateIfNeeded(file: string, maxBytes: number): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size > maxBytes) renameSync(file, `${file}.old`);
}
