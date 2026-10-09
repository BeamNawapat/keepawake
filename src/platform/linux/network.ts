import type { Exec } from "../../ports/exec.js";
import type { NetworkPort } from "../../ports/network.js";

/**
 * `probe` lets the platform factory inject the shared TCP check. Without it we
 * fall back to NetworkManager's own connectivity state.
 */
export function createLinuxNetwork(exec: Exec, probe?: () => Promise<boolean>): NetworkPort {
  return {
    async isOnline() {
      if (probe) return probe();
      const r = await exec.run("nmcli", ["networking", "connectivity", "check"], { timeoutMs: 10000 });
      return r.code === 0 && r.stdout.trim() === "full";
    },
    async connectWifi(ssid) {
      // Radio may be soft-blocked; turning it on when already on is harmless.
      const radio = await exec.run("nmcli", ["radio", "wifi", "on"], { timeoutMs: 10000 });
      if (radio.code !== 0) return false;
      const up = await exec.run("nmcli", ["connection", "up", "id", ssid], { timeoutMs: 30000 });
      return up.code === 0;
    },
  };
}
