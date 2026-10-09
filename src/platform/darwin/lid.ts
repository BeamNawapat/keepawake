import type { Exec } from "../../ports/exec.js";
import type { LidPort, LidSnapshot } from "../../ports/lid.js";
import type { PrivilegePort } from "../../ports/privilege.js";

/**
 * pmset -g prints "SleepDisabled\t\t1" on current macOS. Older builds printed
 * "disablesleep", so keep it as a fallback.
 */
export function parseSleepDisabled(text: string): string {
  const m = /^\s*SleepDisabled\s+(\d)/im.exec(text) ?? /^\s*disablesleep\s+(\d)/im.exec(text);
  return m ? m[1]! : "0";
}

export function createDarwinLid(exec: Exec, privilege: PrivilegePort): LidPort {
  async function ensureSudo(): Promise<void> {
    if (await privilege.isElevated()) return;
    if (!(await privilege.prepare())) throw new Error("sudo authentication failed");
  }

  async function setDisableSleep(value: string): Promise<void> {
    await ensureSudo();
    const r = await exec.run("sudo", ["-n", "pmset", "-a", "disablesleep", value], { timeoutMs: 10000 });
    if (r.code !== 0) throw new Error(`pmset disablesleep ${value} failed (exit ${r.code})`);
  }

  return {
    async snapshot() {
      // Read separately from set() so the caller can persist it before anything changes.
      // If the user already had it on, restore must not turn it off.
      const r = await exec.run("pmset", ["-g"], { timeoutMs: 5000 });
      const snapshot: LidSnapshot = { kind: "darwin", sleepDisabled: parseSleepDisabled(r.stdout) };
      return snapshot;
    },
    async set(snapshot) {
      if (snapshot.kind !== "darwin") return;
      await setDisableSleep("1");
    },
    async restore(snapshot) {
      if (snapshot.kind !== "darwin") return;
      await setDisableSleep(snapshot.sleepDisabled);
    },
  };
}
