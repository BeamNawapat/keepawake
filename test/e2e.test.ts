import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the TypeScript entry through the same runtime as the tests, so no build is needed.
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function kw(home: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, KEEPAWAKE_HOME: home, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 30000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("cli basics", () => {
  const home = mkdtempSync(join(tmpdir(), "kw-e2e-"));

  test("--version prints a version and exits 0", () => {
    const r = kw(home, "--version");
    expect(r.code).toBe(0);
    expect(r.out.trim()).not.toBe("");
  });

  test("--help lists the commands", () => {
    const r = kw(home, "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("keepawake start");
  });

  test("unknown command exits 1", () => {
    expect(kw(home, "frobnicate").code).toBe(1);
  });

  test("bad flag exits 2", () => {
    expect(kw(home, "start", "--for", "1h").code).toBe(2);
  });

  test("check exits 0 or 1 and --json is valid", () => {
    const r = kw(home, "check", "--json");
    expect([0, 1]).toContain(r.code ?? -1);
    const j = JSON.parse(r.out) as { found: boolean };
    expect(r.code ?? -1).toBe(j.found ? 0 : 1);
  });

  test("stop with nothing running exits 0", () => {
    expect(kw(home, "stop").code).toBe(0);
  });

  test("setup-auto refuses --lid", () => {
    const r = kw(home, "setup-auto", "--lid");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--lid");
  });
});

// On Linux the daemon exits on purpose when logind refuses the inhibitor (CI runners
// often have no session bus), so only run the lifecycle test where an inhibit works.
function linuxCanInhibit(): boolean {
  const list = spawnSync("systemd-inhibit", ["--list"], { encoding: "utf8", timeout: 5000 });
  if (list.status !== 0) return false;
  const probe = spawnSync("systemd-inhibit", ["--what=idle", "--who=keepawake-test", "--why=probe", "true"], {
    encoding: "utf8",
    timeout: 5000,
  });
  return probe.status === 0;
}

const canRun =
  process.platform === "win32" ||
  (process.platform === "darwin" && existsSync("/usr/bin/caffeinate")) ||
  (process.platform === "linux" && linuxCanInhibit());

describe.skipIf(!canRun || process.env.CI === "skip-e2e")("daemon lifecycle", () => {
  test("start --always -d, status --json, stop", () => {
    const home = mkdtempSync(join(tmpdir(), "kw-e2e-"));
    try {
      const s = kw(home, "start", "--always", "-d");
      expect(s.code).toBe(0);

      type St = { running: boolean; pid: number; holderPid: number | null; options: { always: boolean } };
      // The first tick (process scan, then acquire) runs shortly after the daemon writes its pid.
      let st = JSON.parse(kw(home, "status", "--json").out) as St;
      for (let i = 0; i < 20 && st.holderPid === null; i++) {
        spawnSync("sleep", ["0.25"]);
        st = JSON.parse(kw(home, "status", "--json").out) as St;
      }
      expect(st.running).toBe(true);
      expect(st.options.always).toBe(true);
      expect(st.holderPid).not.toBeNull();

      const again = kw(home, "start", "--always", "-d");
      expect(again.code).toBe(1);
      expect(again.err).toContain("Already running");
    } finally {
      expect(kw(home, "stop").code).toBe(0);
    }
    const after = JSON.parse(kw(home, "status", "--json").out) as { running: boolean };
    expect(after.running).toBe(false);
  }, 60000);
});
