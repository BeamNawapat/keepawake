import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlags, type Ctx } from "../src/commands/common.js";
import { runMonitor } from "../src/commands/daemon.js";
import { MASCOT_LINES, renderMascot, shouldShowMascot } from "../src/core/mascot.js";
import { resolvePaths } from "../src/core/paths.js";
import { writeState } from "../src/core/state.js";
import { createUi } from "../src/core/ui.js";
import type { Platform } from "../src/platform/index.js";
import { fakeExec } from "./fake-exec.js";

const tag = { yellow: (s: string) => `<y>${s}</y>` };

describe("mascot art", () => {
  test("five lines, 7-bit ASCII, at most 22 columns", () => {
    expect(MASCOT_LINES).toHaveLength(5);
    for (const l of renderMascot({ yellow: (s) => s })) {
      expect(/^[\x20-\x7e]*$/.test(l)).toBe(true);
      expect(l.length).toBeLessThanOrEqual(22);
    }
  });

  test("yellow wraps the lantern body only", () => {
    const out = renderMascot(tag);
    expect(out.join("").match(/<y>/g)).toHaveLength(3);
    expect(out[2]).toBe("   |   u   |--<y>|#|</y>");
    // the ghost lines carry no paint at all
    expect(out[0]).toBe("    .-===-.");
    expect(out[4]).toBe("    '-^-^-'");
    expect(out.join("")).not.toMatch(/[{}]/);
  });
});

describe("shouldShowMascot", () => {
  test("gates", () => {
    expect(shouldShowMascot({}, false, "foreground")).toBe(false);
    expect(shouldShowMascot({ KEEPAWAKE_NO_MASCOT: "1" }, true, "foreground")).toBe(false);
    expect(shouldShowMascot({}, true, "daemon")).toBe(false);
    expect(shouldShowMascot({}, true, "foreground")).toBe(true);
    expect(shouldShowMascot({ KEEPAWAKE_NO_MASCOT: "0" }, true, "foreground")).toBe(true);
  });
});

describe("foreground banner", () => {
  async function banner(isTTY: boolean, env: NodeJS.ProcessEnv, mode: "foreground" | "daemon" = "foreground") {
    const dir = mkdtempSync(join(tmpdir(), "kw-mascot-"));
    const paths = resolvePaths({ KEEPAWAKE_HOME: dir }, dir);
    // --always --for 1 ends the loop on its own, so runMonitor returns without a signal.
    const options = parseFlags(["--always", "--for", "1", "--interval", "1"], {}).options;
    writeState(paths.state, {
      version: 1,
      pid: 0,
      startedAt: new Date().toISOString(),
      mode: "foreground",
      cli: "x",
      options,
      holderPid: null,
      lid: null,
    });
    const platform = {
      power: {
        acquire: async () => ({ pid: 4242 }),
        release: async () => "released" as const,
      },
      processes: { list: async () => [] },
      network: { isOnline: async () => true },
      lid: { restore: async () => {} },
    } as unknown as Platform;
    const lines: string[] = [];
    const ctx: Ctx = {
      exec: fakeExec(),
      paths,
      ui: createUi({ isTTY, noColor: true, out: (l) => lines.push(l), err: (l) => lines.push(l) }),
      env,
      makePlatform: () => platform,
    };
    expect(await runMonitor(ctx, mode)).toBe(0);
    return lines;
  }

  test("TTY: mascot, blank line, then the header", async () => {
    const lines = await banner(true, {});
    const header = lines.findIndex((l) => l.includes("keepawake v"));
    expect(header).toBeGreaterThan(0);
    const art = lines.findIndex((l) => l === MASCOT_LINES[0]);
    expect(art).toBeGreaterThanOrEqual(0);
    expect(lines[art + 4]).toBe("    '-^-^-'");
    // header() emits "\n  <title>\n" as one write, so its leading newline is the blank line
    expect(lines[art + 5]?.startsWith("\n")).toBe(true);
    expect(art + 5).toBe(header);
  }, 15000);

  test("no mascot without a TTY, with KEEPAWAKE_NO_MASCOT=1, or in daemon mode", async () => {
    for (const lines of [
      await banner(false, {}),
      await banner(true, { KEEPAWAKE_NO_MASCOT: "1" }),
      await banner(true, {}, "daemon"),
    ]) {
      expect(lines.some((l) => l.includes(".-===-."))).toBe(false);
    }
  }, 30000);
});
