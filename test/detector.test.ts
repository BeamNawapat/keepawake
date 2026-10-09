import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS } from "../src/core/agents.js";
import { detectAgents } from "../src/core/detector.js";
import { createPosixProcessLister, joinPs } from "../src/platform/posix-ps.js";
import type { ProcessInfo } from "../src/ports/processes.js";
import { fakeExec } from "./fake-exec.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("//"))
    .join("\n");
}

const commText = fixture("ps-darwin-comm.txt");
const argsText = fixture("ps-darwin-args.txt");
const procs = joinPs(commText, argsText);
const ids = (d: ReturnType<typeof detectAgents>) => d.map((x) => x.id);

describe("posix ps parsing", () => {
  test("joins comm and args by pid, keeps spaces in paths", () => {
    expect(procs.find((p) => p.pid === 11657)).toEqual({
      pid: 11657,
      ppid: 1,
      comm: "/Applications/Claude.app/Contents/MacOS/Claude",
      args: "/Applications/Claude.app/Contents/MacOS/Claude",
    });
  });

  test("lister runs both ps calls and degrades when the args call fails", async () => {
    const exec = fakeExec({
      "ps -axo pid=,ppid=,comm=": commText,
      "ps -axo pid=,args=": { code: 1 },
    });
    const list = await createPosixProcessLister(exec).list();
    expect(list.length).toBe(procs.length);
    expect(list.every((p) => p.args === undefined)).toBe(true);
  });

  test("lister throws when the comm call fails", async () => {
    await expect(createPosixProcessLister(fakeExec()).list()).rejects.toThrow("ps failed");
  });
});

describe("detectAgents on the darwin fixture", () => {
  const found = detectAgents(procs, AGENTS, { platform: "darwin" });

  test("every registry id has at least one positive fixture", () => {
    expect(ids(found).sort()).toEqual(AGENTS.map((a) => a.id).sort());
  });

  test("claude CLI and Claude.app are separate agents", () => {
    const code = found.find((d) => d.id === "claude-code");
    const desktop = found.find((d) => d.id === "claude-desktop");
    expect(code?.pids).toEqual([3445, 52497, 13001]);
    expect(desktop?.pids).toEqual([11657]);
  });

  test("codex npm wrapper and native child count as one agent", () => {
    const codex = found.filter((d) => d.id === "codex");
    expect(codex.length).toBe(1);
    expect(codex[0]?.pids).toEqual([20001, 20003]);
  });

  test("decoys never match", () => {
    const decoyPids = new Set([30001, 30002, 30003, 30004, 30005]);
    for (const d of found) for (const pid of d.pids) expect(decoyPids.has(pid)).toBe(false);
  });

  test("a bare node or python process is not an agent", () => {
    const bare: ProcessInfo[] = [
      { pid: 1, ppid: 0, comm: "node", args: "node" },
      { pid: 2, ppid: 0, comm: "python3", args: "python3" },
      { pid: 3, ppid: 0, comm: "bun", args: "bun run dev" },
      { pid: 4, ppid: 0, comm: "sh", args: "sh -c claude" },
    ];
    expect(detectAgents(bare, AGENTS, { platform: "darwin" })).toEqual([]);
  });
});

describe("detectAgents options", () => {
  test("selfPids are excluded", () => {
    const d = detectAgents(procs, AGENTS, { platform: "darwin", selfPids: [3445, 52497, 13001] });
    expect(ids(d)).not.toContain("claude-code");
  });

  test("includeApps=false drops app entries only", () => {
    const d = detectAgents(procs, AGENTS, { platform: "darwin", includeApps: false });
    expect(ids(d)).not.toContain("claude-desktop");
    expect(ids(d)).not.toContain("cursor");
    expect(ids(d)).not.toContain("kiro");
    expect(ids(d)).toContain("claude-code");
  });

  test("ignore list is case-insensitive", () => {
    expect(ids(detectAgents(procs, AGENTS, { platform: "darwin", ignore: ["Cursor"] }))).not.toContain("cursor");
  });

  test("a process whose argv mentions keepawake never counts", () => {
    const self: ProcessInfo[] = [
      { pid: 9, ppid: 1, comm: "claude", args: "claude --resume keepawake-notes" },
      { pid: 10, ppid: 1, comm: "node", args: "node /x/@anthropic-ai/claude-code/cli.js keepawake" },
    ];
    expect(detectAgents(self, AGENTS, { platform: "darwin" })).toEqual([]);
  });
});

describe("win32 naming", () => {
  const win: ProcessInfo[] = [
    { pid: 1, ppid: 0, comm: "claude.exe", exePath: "C:\\Users\\dev\\.local\\bin\\claude.exe", args: "claude.exe" },
    { pid: 2, ppid: 0, comm: "Claude.exe", exePath: "C:\\Users\\dev\\AppData\\Local\\AnthropicClaude\\app-1.0\\Claude.exe" },
    { pid: 3, ppid: 0, comm: "CURSOR.EXE", exePath: "C:\\Program Files\\Cursor\\Cursor.exe" },
  ];
  const d = detectAgents(win, AGENTS, { platform: "win32" });

  test("strips .exe and ignores case", () => {
    expect(ids(d)).toContain("cursor");
  });

  test("MSIX/Store Claude Desktop is not counted as Claude Code", () => {
    const store: ProcessInfo[] = [
      { pid: 9, ppid: 0, comm: "Claude.exe", exePath: "C:\\Program Files\\WindowsApps\\Claude_1.2.3.0_x64__abc123\\app\\Claude.exe" },
    ];
    const r = detectAgents(store, AGENTS, { platform: "win32", includeApps: true });
    expect(r.find((x) => x.id === "claude-desktop")?.pids).toEqual([9]);
    expect(r.find((x) => x.id === "claude-code")).toBeUndefined();
  });

  test("exePath separates desktop from CLI", () => {
    expect(d.find((x) => x.id === "claude-code")?.pids).toEqual([1]);
    expect(d.find((x) => x.id === "claude-desktop")?.pids).toEqual([2]);
  });
});
