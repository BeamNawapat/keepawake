export const GLYPH = {
  ok: "✔",
  warn: "⚠",
  fail: "✘",
  cup: "☕",
  bolt: "⚡",
  sleep: "💤",
  dish: "📡",
  wifi: "📶",
  key: "🔑",
} as const;

export interface UiOptions {
  isTTY: boolean;
  noColor: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface Ui {
  info(msg: string): void;
  warn(msg: string): void;
  err(msg: string): void;
  dim(msg: string): void;
  header(msg: string): void;
  /** Plain line, no glyph. */
  line(msg: string): void;
  /** Wrap text in the accent colors used by status output. */
  paint: { green(s: string): string; yellow(s: string): string; red(s: string): string; bold(s: string): string };
}

export function createUi(opts?: Partial<UiOptions>): Ui {
  const o: UiOptions = {
    isTTY: process.stdout.isTTY === true,
    noColor: "NO_COLOR" in process.env,
    out: (l) => process.stdout.write(l + "\n"),
    err: (l) => process.stderr.write(l + "\n"),
    ...opts,
  };
  const color = o.isTTY && !o.noColor;
  const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const green = wrap("0;32");
  const yellow = wrap("1;33");
  const red = wrap("0;31");
  const blue = wrap("0;34");
  const dim = wrap("2");
  const bold = wrap("1");

  return {
    info: (m) => o.out(`  ${green(GLYPH.ok)} ${m}`),
    warn: (m) => o.out(`  ${yellow(GLYPH.warn)} ${m}`),
    err: (m) => o.err(`  ${red(GLYPH.fail)} ${m}`),
    dim: (m) => o.out(`  ${dim(m)}`),
    header: (m) => o.out(`\n  ${bold(blue(`${GLYPH.cup} ${m}`))}\n`),
    line: (m) => o.out(m),
    paint: { green, yellow, red, bold },
  };
}
