import type { Exec } from "../../ports/exec.js";
import type { NetworkPort } from "../../ports/network.js";
import { isOnline, tcpProbe, type TcpProbe } from "./tcp-probe.js";

export function parseWifiInterface(text: string): string | null {
  const m = /Hardware Port:\s*(?:Wi-Fi|AirPort)\s*\r?\nDevice:\s*(\S+)/i.exec(text);
  return m ? m[1]! : null;
}

export interface DarwinNetworkDeps {
  probe?: TcpProbe;
  sleep?: (ms: number) => Promise<void>;
}

export function createDarwinNetwork(exec: Exec, deps: DarwinNetworkDeps = {}): NetworkPort {
  const probe = deps.probe ?? tcpProbe;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    isOnline: () => isOnline(probe),
    async connectWifi(ssid) {
      const ports = await exec.run("networksetup", ["-listallhardwareports"], { timeoutMs: 5000 });
      const iface = parseWifiInterface(ports.stdout);
      if (!iface) return false;

      const power = await exec.run("networksetup", ["-getairportpower", iface], { timeoutMs: 5000 });
      if (/off\s*$/i.test(power.stdout.trim())) {
        await exec.run("networksetup", ["-setairportpower", iface, "on"], { timeoutMs: 10000 });
        await sleep(2000);
      }

      // networksetup exits 0 even when the join fails, and prints the reason on stdout.
      const r = await exec.run("networksetup", ["-setairportnetwork", iface, ssid], { timeoutMs: 30000 });
      return r.code === 0 && !/failed|could not|error/i.test(r.stdout + r.stderr);
    },
  };
}
