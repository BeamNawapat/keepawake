export interface AgentDef {
  id: string;
  label: string;
  kind: "cli" | "app";
  /**
   * Executable basename, exact match, ".exe" stripped. Compared case-sensitively
   * except on win32: macOS has both `claude` (CLI) and `Claude` (desktop app).
   */
  comm?: string[];
  /** Tested against the full command line. Required for node/python-hosted tools. */
  argv?: RegExp[];
  /** Positive filter on the executable path, used to split Claude.exe from claude.exe on Windows. */
  exePath?: RegExp[];
  /** A comm match is rejected when the executable path matches one of these. */
  excludeExePath?: RegExp[];
}

const CLAUDE_DESKTOP_WIN = /AnthropicClaude|[\\/]Claude[\\/]Claude\.exe$/i;

/**
 * THE registry. Adding an agent = one entry here + one line in each fixture
 * file under test/fixtures. Never list bare `node`, `python*`, `bun` or `sh`
 * as comm: those only count when an argv pattern also matches.
 *
 * Verified entries were checked against real `ps` output; the rest are
 * inferred from the tools' docs and flagged in the fixtures ("// inferred").
 */
export const AGENTS: readonly AgentDef[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "cli",
    comm: ["claude"],
    argv: [/@anthropic-ai[\\/]claude-code/, /\.local[\\/]share[\\/]claude/],
    excludeExePath: [CLAUDE_DESKTOP_WIN],
  },
  { id: "claude-desktop", label: "Claude Desktop", kind: "app", comm: ["Claude"], exePath: [CLAUDE_DESKTOP_WIN] },
  { id: "codex", label: "Codex CLI", kind: "cli", comm: ["codex"], argv: [/@openai[\\/]codex/] },
  { id: "gemini", label: "Gemini CLI", kind: "cli", argv: [/@google[\\/]gemini-cli/, /gemini\.js/] },
  { id: "cursor", label: "Cursor", kind: "app", comm: ["Cursor"] },
  { id: "cursor-agent", label: "Cursor Agent", kind: "cli", argv: [/cursor-agent[\\/]versions/] },
  { id: "opencode", label: "OpenCode", kind: "cli", comm: ["opencode"] },
  { id: "aider", label: "Aider", kind: "cli", argv: [/[\\/]aider(\s|$)/] },
  { id: "copilot", label: "Copilot CLI", kind: "cli", comm: ["copilot"], argv: [/@github[\\/]copilot/] },
  { id: "kiro", label: "Kiro", kind: "app", comm: ["Kiro"] },
  { id: "kiro-cli", label: "Kiro CLI", kind: "cli", comm: ["kiro-cli", "kiro-cli-chat"] },
  { id: "amp", label: "Amp", kind: "cli", comm: ["amp"], argv: [/@sourcegraph[\\/]amp|@ampcode[\\/]cli/] },
];
