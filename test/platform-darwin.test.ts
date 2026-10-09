import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { createDarwinAutostart, LAUNCH_LABEL } from "../src/platform/darwin/autostart.js";
import { createDarwinLid, parseSleepDisabled } from "../src/platform/darwin/lid.js";
import { createDarwinNetwork, parseWifiInterface } from "../src/platform/darwin/network.js";
import { createDarwinPower } from "../src/platform/darwin/power.js";
import { createDarwinPrivilege } from "../src/platform/darwin/privilege.js";
import { createDarwinProcessLister } from "../src/platform/darwin/processes.js";
import { fakeExec } from "./fake-exec.js";

const PMSET_OFF = "System-wide power settings:\n SleepDisabled\t\t0\n sleep 1\n";
const PMSET_ON = "System-wide power settings:\n SleepDisabled\t\t1\n";
const HW_PORTS = `Hardware Port: Ethernet Adapter (en3)
Device: en3
Ethernet Address: aa

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: bb
`;

describe("darwin privilege prompt", () => {
  test("prints the prompt once and a confirmation after sudo -v succeeds", async () => {
    const out: string[] = [];
    const priv = createDarwinPrivilege(fakeExec(), { interactive: async () => 0, write: (t) => out.push(t) });
    expect(await priv.prepare()).toBe(true);
    const text = out.join("");
    expect(text.match(/โหมด --lid ต้องใช้สิทธิ์ admin/g)).toHaveLength(1);
    expect(text).toContain("✔ รหัสถูกต้อง — sudo พร้อมใช้");
  });
});

describe("darwin lid", () => {
  test("parses SleepDisabled and the old disablesleep spelling", () => {
    expect(parseSleepDisabled(PMSET_ON)).toBe("1");
    expect(parseSleepDisabled(PMSET_OFF)).toBe("0");
    expect(parseSleepDisabled(" disablesleep 1\n")).toBe("1");
    expect(parseSleepDisabled("")).toBe("0");
  });

  test("snapshot then set; restore sets the snapshot value", async () => {
    const exec = fakeExec({
      "pmset -g": PMSET_OFF,
      "sudo -n true": "",
      "sudo -n pmset -a disablesleep 1": "",
      "sudo -n pmset -a disablesleep 0": "",
    });
    const lid = createDarwinLid(exec, createDarwinPrivilege(exec));
    const snap = await lid.snapshot();
    expect(snap).toEqual({ kind: "darwin", sleepDisabled: "0" });
    expect(exec.calls).toEqual(["pmset -g"]);
    await lid.set(snap);
    await lid.restore(snap);
    expect(exec.calls).toEqual([
      "pmset -g",
      "sudo -n true",
      "sudo -n pmset -a disablesleep 1",
      "sudo -n true",
      "sudo -n pmset -a disablesleep 0",
    ]);
  });

  test("restore leaves a pre-existing disablesleep=1 on", async () => {
    const exec = fakeExec({
      "sudo -n true": "",
      "sudo -n pmset -a disablesleep 1": "",
    });
    const lid = createDarwinLid(exec, createDarwinPrivilege(exec));
    await lid.restore({ kind: "darwin", sleepDisabled: "1" });
    expect(exec.calls).toContain("sudo -n pmset -a disablesleep 1");
  });

  test("prompts via sudo -v when the ticket is gone, throws when refused", async () => {
    const exec = fakeExec({ "pmset -g": PMSET_OFF, "sudo -n true": { code: 1 } });
    const asked: string[][] = [];
    const out: string[] = [];
    const priv = createDarwinPrivilege(exec, {
      interactive: async (c, a) => (asked.push([c, ...a]), 1),
      write: (t) => out.push(t),
    });
    await expect(createDarwinLid(exec, priv).set({ kind: "darwin", sleepDisabled: "0" })).rejects.toThrow(
      "sudo authentication failed",
    );
    expect(asked).toEqual([["sudo", "-v"]]);
    expect(out.join("")).toContain("โหมด --lid ต้องใช้สิทธิ์ admin");
    expect(exec.calls).not.toContain("sudo -n pmset -a disablesleep 1");
  });
});

function fakeChild(pid: number): ChildProcess {
  const e = new EventEmitter() as ChildProcess;
  (e as { pid: number }).pid = pid;
  e.unref = () => e;
  queueMicrotask(() => e.emit("spawn"));
  return e;
}

describe("darwin power", () => {
  test("spawns caffeinate -i -m -s [-d] -w ownerPid", async () => {
    const seen: Array<[string, string[]]> = [];
    const power = createDarwinPower(fakeExec(), (c, a) => (seen.push([c, a]), fakeChild(500)));
    expect(await power.acquire({ display: false, ownerPid: 42 })).toEqual({ pid: 500 });
    await power.acquire({ display: true, ownerPid: 42 });
    expect(seen[0]).toEqual(["/usr/bin/caffeinate", ["-i", "-m", "-s", "-w", "42"]]);
    expect(seen[1]![1]).toEqual(["-i", "-m", "-s", "-d", "-w", "42"]);
  });

  test("release kills only after argv verifies", async () => {
    const exec = fakeExec({
      "ps -p 500 -o args=": "/usr/bin/caffeinate -i -m -s -w 42\n",
      "kill 500": "",
    });
    expect(await createDarwinPower(exec).release({ pid: 500, ownerPid: 42 })).toBe(true);
    expect(exec.calls).toEqual(["ps -p 500 -o args=", "kill 500"]);
  });

  test("release skips a reused pid, a foreign caffeinate and a vanished pid", async () => {
    const reused = fakeExec({ "ps -p 500 -o args=": "/usr/bin/vim notes.txt\n" });
    expect(await createDarwinPower(reused).release({ pid: 500, ownerPid: 42 })).toBe(false);
    expect(reused.calls).toEqual(["ps -p 500 -o args="]);

    const other = fakeExec({ "ps -p 500 -o args=": "caffeinate -i -t 300\n" });
    expect(await createDarwinPower(other).release({ pid: 500, ownerPid: 42 })).toBe(false);
    expect(other.calls).toEqual(["ps -p 500 -o args="]);

    // A fresh stop process has no in-memory owner map, so the owner must come from the caller.
    const foreign = fakeExec({ "ps -p 500 -o args=": "/usr/bin/caffeinate -i -m -s -w 99\n" });
    expect(await createDarwinPower(foreign).release({ pid: 500, ownerPid: 42 })).toBe(false);
    expect(foreign.calls).not.toContain("kill 500");

    const gone = fakeExec({ "ps -p 500 -o args=": { code: 1 } });
    expect(await createDarwinPower(gone).release({ pid: 500, ownerPid: 42 })).toBe(false);
    expect(gone.calls).toEqual(["ps -p 500 -o args="]);
  });
});

describe("darwin processes", () => {
  test("runs the two ps calls", async () => {
    const exec = fakeExec({
      "ps -axo pid=,ppid=,comm=": "  1 0 /sbin/launchd\n",
      "ps -axo pid=,args=": "  1 /sbin/launchd\n",
    });
    expect(await createDarwinProcessLister(exec).list()).toEqual([
      { pid: 1, ppid: 0, comm: "/sbin/launchd", args: "/sbin/launchd" },
    ]);
  });
});

describe("darwin network", () => {
  test("finds the Wi-Fi device", () => {
    expect(parseWifiInterface(HW_PORTS)).toBe("en0");
    expect(parseWifiInterface("Hardware Port: Thunderbolt\nDevice: en1\n")).toBeNull();
  });

  test("isOnline tries 1.1.1.1:443 then 8.8.8.8:53", async () => {
    const tried: string[] = [];
    const net = createDarwinNetwork(fakeExec(), {
      probe: async (h, p) => (tried.push(`${h}:${p}`), h === "8.8.8.8"),
    });
    expect(await net.isOnline()).toBe(true);
    expect(tried).toEqual(["1.1.1.1:443", "8.8.8.8:53"]);
  });

  test("connectWifi powers on a disabled radio then joins", async () => {
    const exec = fakeExec({
      "networksetup -listallhardwareports": HW_PORTS,
      "networksetup -getairportpower en0": "Wi-Fi Power (en0): Off\n",
      "networksetup -setairportpower en0 on": "",
      "networksetup -setairportnetwork en0 Beam": "",
    });
    const net = createDarwinNetwork(exec, { sleep: async () => {} });
    expect(await net.connectWifi("Beam")).toBe(true);
    expect(exec.calls).toEqual([
      "networksetup -listallhardwareports",
      "networksetup -getairportpower en0",
      "networksetup -setairportpower en0 on",
      "networksetup -setairportnetwork en0 Beam",
    ]);
  });

  test("connectWifi reports failure text printed with exit 0, and a missing radio", async () => {
    const bad = fakeExec({
      "networksetup -listallhardwareports": HW_PORTS,
      "networksetup -getairportpower en0": "Wi-Fi Power (en0): On\n",
      "networksetup -setairportnetwork en0 Beam": "Failed to join network Beam.\n",
    });
    expect(await createDarwinNetwork(bad).connectWifi("Beam")).toBe(false);
    const none = fakeExec({ "networksetup -listallhardwareports": "" });
    expect(await createDarwinNetwork(none).connectWifi("Beam")).toBe(false);
  });
});

describe("darwin autostart", () => {
  const mk = (replies: Record<string, never | string | { code: number }>) => {
    const home = mkdtempSync(join(tmpdir(), "ka-"));
    const exec = fakeExec(replies);
    const port = createDarwinAutostart(exec, {
      home,
      nodePath: "/usr/local/bin/node",
      cliPath: "/x/dist/cli.js",
      logFile: "/h/.keepawake/keepawake.log",
      uid: 501,
    });
    return { home, exec, port };
  };
  const plist = (home: string) => join(home, "Library/LaunchAgents", `${LAUNCH_LABEL}.plist`);

  test("install writes the plist and bootstraps gui/uid", async () => {
    const { home, exec, port } = mk({ [`launchctl bootout gui/501/${LAUNCH_LABEL}`]: { code: 113 } });
    // Every other launchctl call is unknown to the fake (127), so the load fallback fails and throws.
    await expect(port.install(["--always"])).rejects.toThrow("launchctl could not load");
    const text = readFileSync(plist(home), "utf8");
    expect(text).toContain("<string>com.beamnawapat.keepawake</string>");
    expect(text).toContain("<string>/usr/local/bin/node</string>");
    expect(text).toContain("<string>start</string>");
    expect(text).toContain("<string>--always</string>");
    expect(exec.calls[0]).toBe(`launchctl bootout gui/501/${LAUNCH_LABEL}`);
    expect(exec.calls).toContain(`launchctl bootstrap gui/501 ${plist(home)}`);
    expect(exec.calls).toContain(`launchctl load ${plist(home)}`);
  });

  test("install succeeds with bootstrap, falls back to load when bootstrap fails", async () => {
    const a = mk({});
    const p = plist(a.home);
    const ok = createDarwinAutostart(
      fakeExec({
        [`launchctl bootout gui/501/${LAUNCH_LABEL}`]: "",
        [`launchctl bootstrap gui/501 ${p}`]: "",
      }),
      { home: a.home, nodePath: "n", cliPath: "c", logFile: "l", uid: 501 },
    );
    expect(await ok.install([])).toEqual({ path: p });
    const fb = createDarwinAutostart(
      fakeExec({
        [`launchctl bootout gui/501/${LAUNCH_LABEL}`]: "",
        [`launchctl bootstrap gui/501 ${p}`]: { code: 5 },
        [`launchctl load ${p}`]: "",
      }),
      { home: a.home, nodePath: "n", cliPath: "c", logFile: "l", uid: 501 },
    );
    expect(await fb.install([])).toEqual({ path: p });
  });

  test("remove boots out, deletes the file, and reports absence", async () => {
    const { home, port } = mk({});
    expect(await port.remove()).toBe(false);
    expect(await port.isInstalled()).toBe(false);
    await port.install([]).catch(() => {});
    expect(await port.isInstalled()).toBe(true);
    expect(await port.remove()).toBe(true);
    expect(existsSync(plist(home))).toBe(false);
  });

  test("escapes XML in arguments", async () => {
    const { home, port } = mk({});
    await port.install(["--hotspot", "A&B <1>"]).catch(() => {});
    expect(readFileSync(plist(home), "utf8")).toContain("A&amp;B &lt;1&gt;");
  });
});
