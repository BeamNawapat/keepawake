/**
 * The night-watchman ghost shown above the foreground `start` banner.
 * Pure 7-bit ASCII so it renders in cmd/PowerShell under any code page.
 * `{...}` marks the lantern body; renderMascot strips the braces and paints that span.
 */
export const MASCOT_LINES: readonly string[] = [
  "    .-===-.",
  "   /  o o  \\   {.-.}",
  "   |   u   |--{|#|}",
  "   \\       /   {'-'}",
  "    '-^-^-'",
];

const LANTERN = /\{([^}]*)\}/g;

export function renderMascot(paint: { yellow(s: string): string }): string[] {
  return MASCOT_LINES.map((l) => l.replace(LANTERN, (_m, body: string) => paint.yellow(body)));
}

/** Foreground terminal only: a daemon's stdout is the log file, and a pipe does not want art. */
export function shouldShowMascot(env: NodeJS.ProcessEnv, isTTY: boolean, mode: "foreground" | "daemon"): boolean {
  return mode === "foreground" && isTTY && env.KEEPAWAKE_NO_MASCOT !== "1";
}
