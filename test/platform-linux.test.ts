import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeExec } from "./fake-exec.js";
import { createLinuxPower, inhibitArgs } from "../src/platform/linux/power.js";
import { createLinuxNetwork } from "../src/platform/linux/network.js";
import { createLinuxAutostart, quoteSystemd } from "../src/platform/linux/autostart.js";
import { createLinuxProcessLister } from "../src/platform/linux/processes.js";
import { createLinuxLid } from "../src/platform/linux/lid.js";
import { createLinuxPrivilege } from "../src/platform/linux/privilege.js";
import { UnsupportedError } from "../src/platform/linux/errors.js";

describe("linux power", () => {
  test("acquire spawns systemd-inhibit and returns its pid", async () => {
    const spawned: string[][] = [];
    const power = createLinuxPower(fakeExec({ "systemd-inhibit --list": "" }), {
      spawnHolder: async (cmd, args) => (spawned.push([cmd, ...args]), { pid: 4242 }),
    });
    expect(await power.acquire({ display: false, ownerPid: 1 })).toEqual({ pid: 4242 });
    expect(spawned[0]).toEqual([
      "systemd-inhibit", "--what=idle:sleep", "--who=keepawake", "--why=agent running", "sleep", "infinity",
    ]);
  });

  test("lid option adds handle-lid-switch", () => {
    expect(inhibitArgs({ lid: true })[0]).toBe("--what=idle:sleep:handle-lid-switch");
  });

  test("missing systemd-inhibit gives UnsupportedError with a clear message", async () => {
    const power = createLinuxPower(fakeExec(), { spawnHolder: async () => ({ pid: 1 }) });
    const err = await power.acquire({ display: false, ownerPid: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect(err.message).toContain("systemd-inhibit not found");
  });

  test("logind unreachable gives UnsupportedError", async () => {
    const power = createLinuxPower(fakeExec({ "systemd-inhibit --list": { code: 1 } }));
    await expect(power.acquire({ display: false, ownerPid: 1 })).rejects.toBeInstanceOf(UnsupportedError);
  });

  test("spawn failure gives UnsupportedError", async () => {
    const power = createLinuxPower(fakeExec({ "systemd-inhibit --list": "" }), {
      spawnHolder: async () => { throw new Error("EACCES"); },
    });
    await expect(power.acquire({ display: false, ownerPid: 1 })).rejects.toBeInstanceOf(UnsupportedError);
  });

  test("release sends SIGTERM and tolerates ESRCH", async () => {
    const sent: Array<[number, string]> = [];
    const ok = createLinuxPower(fakeExec(), { kill: (p, s) => void sent.push([p, s]) });
    await ok.release({ pid: 7 });
    expect(sent).toEqual([[7, "SIGTERM"]]);
    const gone = createLinuxPower(fakeExec(), {
      kill: () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); },
    });
    await gone.release({ pid: 7 });
    const denied = createLinuxPower(fakeExec(), {
      kill: () => { throw Object.assign(new Error("x"), { code: "EPERM" }); },
    });
    await expect(denied.release({ pid: 7 })).rejects.toThrow();
  });
});

describe("linux network", () => {
  test("isOnline reads nmcli connectivity", async () => {
    const yes = createLinuxNetwork(fakeExec({ "nmcli networking connectivity check": "full\n" }));
    expect(await yes.isOnline()).toBe(true);
    const no = createLinuxNetwork(fakeExec({ "nmcli networking connectivity check": "none\n" }));
    expect(await no.isOnline()).toBe(false);
    expect(await createLinuxNetwork(fakeExec()).isOnline()).toBe(false);
  });

  test("injected probe wins over nmcli", async () => {
    const ex = fakeExec();
    expect(await createLinuxNetwork(ex, async () => true).isOnline()).toBe(true);
    expect(ex.calls).toEqual([]);
  });

  test("connectWifi turns the radio on then brings the profile up", async () => {
    const ex = fakeExec({ "nmcli radio wifi on": "", "nmcli connection up id My Phone": "ok" });
    expect(await createLinuxNetwork(ex).connectWifi("My Phone")).toBe(true);
    expect(ex.calls).toEqual(["nmcli radio wifi on", "nmcli connection up id My Phone"]);
  });

  test("connectWifi false when nmcli is missing or profile fails", async () => {
    expect(await createLinuxNetwork(fakeExec()).connectWifi("x")).toBe(false);
    const ex = fakeExec({ "nmcli radio wifi on": "", "nmcli connection up id x": { code: 10 } });
    expect(await createLinuxNetwork(ex).connectWifi("x")).toBe(false);
  });
});

describe("linux autostart", () => {
  test("install writes the unit and enables it", async () => {
    const home = mkdtempSync(join(tmpdir(), "ka-linux-"));
    const ex = fakeExec({
      "systemctl --user daemon-reload": "",
      "systemctl --user enable --now keepawake.service": "",
      "systemctl --user disable --now keepawake.service": "",
    });
    const auto = createLinuxAutostart(ex, home);
    expect(await auto.isInstalled()).toBe(false);
    const { path } = await auto.install(["/usr/bin/node", "/opt/ka dir/cli.js", "start", "--always"]);
    expect(path).toBe(join(home, ".config/systemd/user/keepawake.service"));
    const unit = readFileSync(path, "utf8");
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/ka dir/cli.js" "start" "--always"');
    expect(unit).toContain("WantedBy=default.target");
    expect(ex.calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now keepawake.service",
    ]);
    expect(await auto.isInstalled()).toBe(true);
    expect(await auto.remove()).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await auto.remove()).toBe(false);
  });

  test("install surfaces systemctl failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "ka-linux-"));
    const auto = createLinuxAutostart(fakeExec(), home);
    await expect(auto.install(["node", "cli.js"])).rejects.toThrow("daemon-reload failed");
  });

  test("quoteSystemd escapes specifiers and quotes", () => {
    expect(quoteSystemd('a"b%c$d\\e')).toBe('"a\\"b%%c$$d\\\\e"');
  });
});

describe("linux misc", () => {
  test("process lister reuses ps parsing", async () => {
    const ex = fakeExec({
      "ps -axo pid=,ppid=,comm=": "  10  1 claude\n",
      "ps -axo pid=,args=": "  10 claude --resume\n",
    });
    expect(await createLinuxProcessLister(ex).list()).toEqual([
      { pid: 10, ppid: 1, comm: "claude", args: "claude --resume" },
    ]);
  });

  test("lid and privilege are no-ops", async () => {
    const lid = createLinuxLid();
    expect(await lid.apply()).toEqual({ kind: "linux" });
    await lid.restore({ kind: "linux" });
    const p = createLinuxPrivilege();
    expect(await p.isElevated()).toBe(true);
    expect(await p.prepare()).toBe(true);
  });
});
