import type { Exec } from "../../ports/exec.js";
import type { ProcessInfo, ProcessLister } from "../../ports/processes.js";
import { encodedCommandArgs } from "./powershell.js";

// UTF-8 output so non-ASCII paths and window titles survive the pipe.
const SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
].join("\n");

interface Row {
  ProcessId?: number;
  ParentProcessId?: number;
  Name?: string | null;
  ExecutablePath?: string | null;
  CommandLine?: string | null;
}

/** ConvertTo-Json emits a bare object, not an array, when there is exactly one row. */
export function parseWin32Processes(text: string): ProcessInfo[] {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const rows: Row[] = Array.isArray(parsed) ? parsed : [parsed as Row];
  const out: ProcessInfo[] = [];
  for (const r of rows) {
    if (typeof r.ProcessId !== "number" || !r.Name) continue;
    const info: ProcessInfo = {
      pid: r.ProcessId,
      ppid: r.ParentProcessId ?? 0,
      comm: r.Name.replace(/\.exe$/i, "").toLowerCase(),
    };
    if (r.CommandLine) info.args = r.CommandLine;
    if (r.ExecutablePath) info.exePath = r.ExecutablePath;
    out.push(info);
  }
  return out;
}

export function createWin32ProcessLister(exec: Exec): ProcessLister {
  return {
    async list() {
      const r = await exec.run("powershell.exe", encodedCommandArgs(SCRIPT), { timeoutMs: 20000 });
      if (r.code !== 0) throw new Error(`process listing failed (exit ${r.code})`);
      return parseWin32Processes(r.stdout);
    },
  };
}
