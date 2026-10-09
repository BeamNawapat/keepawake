import { connect } from "node:net";
import type { Exec } from "../../ports/exec.js";
import type { NetworkPort } from "../../ports/network.js";

export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export const tcpProbe: TcpProbe = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

/** First `SSID : name` line. BSSID does not match because the pattern is anchored to the line start. */
export function parseCurrentSsid(text: string): string | null {
  const m = /^\s*SSID(?:\s+\d+)?\s*:\s*(.*?)\s*$/m.exec(text);
  return m && m[1] ? m[1] : null;
}

export interface Win32Network extends NetworkPort {
  currentSsid(): Promise<string | null>;
}

export function createWin32Network(exec: Exec, probe: TcpProbe = tcpProbe): Win32Network {
  return {
    async isOnline() {
      return (await probe("1.1.1.1", 443, 2000)) || (await probe("8.8.8.8", 53, 2000));
    },
    async connectWifi(ssid) {
      // No shell is involved, so quotes are the only hazard: libuv would escape
      // them with a backslash, which netsh does not understand. Refuse instead.
      if (!ssid || /["\r\n\0]/.test(ssid)) return false;
      const r = await exec.run("netsh", ["wlan", "connect", `name=${ssid}`], { timeoutMs: 15000 });
      return r.code === 0;
    },
    async currentSsid() {
      const r = await exec.run("netsh", ["wlan", "show", "interfaces"], { timeoutMs: 10000 });
      return r.code === 0 ? parseCurrentSsid(r.stdout) : null;
    },
  };
}
