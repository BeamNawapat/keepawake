import type { ProcessInfo } from "../ports/processes.js";
import type { AgentDef } from "./agents.js";

export interface DetectOptions {
  /** Pids that must never count (this process, its parent, the daemon). */
  selfPids?: Iterable<number>;
  /** false = skip kind "app" entries (--no-apps). */
  includeApps?: boolean;
  /** Registry ids to skip (KEEPAWAKE_IGNORE). */
  ignore?: Iterable<string>;
  platform?: NodeJS.Platform;
}

export interface Detected {
  id: string;
  label: string;
  kind: AgentDef["kind"];
  /** Every matching pid; one agent can be several processes (npm wrapper + native child). */
  pids: number[];
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

function normalizeComm(comm: string, platform: NodeJS.Platform): string {
  let name = baseName(comm.trim());
  if (platform === "win32") name = name.replace(/\.exe$/i, "");
  return name;
}

function matches(def: AgentDef, proc: ProcessInfo, name: string, platform: NodeJS.Platform): boolean {
  const ci = platform === "win32";
  const exe = proc.exePath;

  if (def.comm?.some((c) => (ci ? c.toLowerCase() === name.toLowerCase() : c === name))) {
    const excluded = exe !== undefined && def.excludeExePath?.some((re) => re.test(exe));
    const required = def.exePath === undefined || exe === undefined || def.exePath.some((re) => re.test(exe));
    if (!excluded && required) return true;
  }
  return proc.args !== undefined && def.argv?.some((re) => re.test(proc.args!)) === true;
}

/** Pure: same process list in, same agents out. Result order follows the registry. */
export function detectAgents(procs: readonly ProcessInfo[], registry: readonly AgentDef[], opts: DetectOptions = {}): Detected[] {
  const platform = opts.platform ?? process.platform;
  const self = new Set(opts.selfPids ?? []);
  const ignore = new Set([...(opts.ignore ?? [])].map((s) => s.toLowerCase()));
  const includeApps = opts.includeApps ?? true;

  // Drop ourselves, and anything whose command line mentions keepawake: that
  // covers `keepawake-claude start` and the __daemon child, whose argv would
  // otherwise match the claude patterns by name.
  const candidates = procs.filter((p) => !self.has(p.pid) && !(p.args ?? "").toLowerCase().includes("keepawake"));

  const found: Detected[] = [];
  for (const def of registry) {
    if (ignore.has(def.id)) continue;
    if (def.kind === "app" && !includeApps) continue;
    const pids = candidates
      .filter((p) => matches(def, p, normalizeComm(p.comm, platform), platform))
      .map((p) => p.pid);
    if (pids.length > 0) found.push({ id: def.id, label: def.label, kind: def.kind, pids });
  }
  return found;
}
