import type { Exec } from "../../ports/exec.js";

/**
 * True when `pid` is running and its image is `image` (default node.exe).
 * Checking the image guards against pid reuse by an unrelated program.
 */
export async function isAliveWin32(exec: Exec, pid: number, image = "node.exe"): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const r = await exec.run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeoutMs: 10000 });
  if (r.code !== 0) return false;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m && Number(m[2]) === pid) return m[1]!.toLowerCase() === image.toLowerCase();
  }
  return false;
}
