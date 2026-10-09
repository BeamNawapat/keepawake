export interface Options {
  always: boolean;
  /** Seconds after start when --always stops by itself; null = never. */
  for: number | null;
  lid: boolean;
  display: boolean;
  hotspot: string | null;
  /** Poll interval in seconds. */
  interval: number;
  /** Count GUI apps (Claude Desktop, Cursor, Kiro) as "working". */
  apps: boolean;
}

export const DEFAULT_INTERVAL = 15;

export function defaultOptions(): Options {
  return { always: false, for: null, lid: false, display: false, hotspot: null, interval: DEFAULT_INTERVAL, apps: true };
}

const UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600 };

/** "2h", "90m", "45s" or plain seconds ("3600"). Returns whole seconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smh]?)$/i.exec(input.trim());
  if (!m) throw new Error(`invalid duration "${input}" (use e.g. 2h, 90m, 45s or plain seconds)`);
  const seconds = Math.round(Number(m[1]) * (UNIT_SECONDS[m[2]!.toLowerCase()] ?? 1));
  if (!(seconds > 0)) throw new Error(`duration must be greater than zero, got "${input}"`);
  return seconds;
}

/** Flag value wins, then KEEPAWAKE_INTERVAL, then the default. Invalid values throw. */
export function resolveInterval(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const raw = flag ?? env.KEEPAWAKE_INTERVAL;
  if (raw === undefined || raw === "") return DEFAULT_INTERVAL;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid interval "${raw}" (whole seconds, at least 1)`);
  return n;
}

/** KEEPAWAKE_IGNORE="cursor,kiro" -> ["cursor", "kiro"]. */
export function parseIgnore(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.KEEPAWAKE_IGNORE ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
