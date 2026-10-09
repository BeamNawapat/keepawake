import { basename } from "node:path";
import type { Exec } from "../../ports/exec.js";
import { encodedCommandArgs } from "./powershell.js";

export interface AliveExpect {
  mode: "daemon" | "foreground";
  cli: string;
}

export interface Win32ProcessRow {
  name: string;
  commandLine: string;
}

/**
 * Name and command line of one pid, or null when it is gone or unreadable.
 * Unknown argv is treated as "not ours" by every caller.
 */
export async function queryWin32Process(exec: Exec, pid: number): Promise<Win32ProcessRow | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const script = [
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select Name,CommandLine | ConvertTo-Json -Compress`,
  ].join("\n");
  const r = await exec.run("powershell.exe", encodedCommandArgs(script), { timeoutMs: 20000 });
  if (r.code !== 0) return null;
  const text = r.stdout.replace(/^﻿/, "").trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const row = (Array.isArray(parsed) ? parsed[0] : parsed) as { Name?: unknown; CommandLine?: unknown } | undefined;
    if (!row || typeof row.Name !== "string" || typeof row.CommandLine !== "string" || !row.CommandLine) return null;
    return { name: row.Name, commandLine: row.CommandLine };
  } catch {
    return null;
  }
}

/** Windows paths are case-insensitive, so compare lowercased. */
export function argvMatches(commandLine: string, expect: AliveExpect): boolean {
  const line = commandLine.toLowerCase();
  const cli = expect.cli.toLowerCase();
  if (!cli) return false;
  return expect.mode === "daemon"
    ? line.includes("__daemon") && line.includes(cli)
    : line.includes(cli) && line.includes(" start");
}

/**
 * True when `pid` is running, its image matches the runtime that spawned the
 * daemon, and its command line is ours. The image check alone would let a
 * reused pid held by any other node.exe through to taskkill.
 */
export async function isAliveWin32(
  exec: Exec,
  pid: number,
  expect: AliveExpect,
  image = basename(process.execPath),
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const r = await exec.run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeoutMs: 10000 });
  if (r.code !== 0) return false;
  let imageOk = false;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m && Number(m[2]) === pid) {
      imageOk = m[1]!.toLowerCase() === image.toLowerCase();
      break;
    }
  }
  if (!imageOk) return false;
  const row = await queryWin32Process(exec, pid);
  return row !== null && argvMatches(row.commandLine, expect);
}
