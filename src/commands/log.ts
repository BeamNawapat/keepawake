import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watchFile } from "node:fs";
import type { Ctx } from "./common.js";

/** tail -f in plain Node so it also works on Windows. Runs until the user hits Ctrl+C. */
export async function log(ctx: Ctx): Promise<number> {
  const file = ctx.paths.log;
  if (!existsSync(file)) {
    ctx.ui.dim("No log file yet");
    return 0;
  }
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  process.stdout.write(lines.slice(-21).join("\n"));
  let pos = statSync(file).size;

  watchFile(file, { interval: 500 }, (cur) => {
    // Smaller than before means the logger rotated the file; start over.
    if (cur.size < pos) pos = 0;
    if (cur.size === pos) return;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(cur.size - pos);
      const n = readSync(fd, buf, 0, buf.length, pos);
      process.stdout.write(buf.subarray(0, n));
      pos += n;
    } finally {
      closeSync(fd);
    }
  });
  return new Promise<number>(() => {});
}
