import { connect } from "node:net";

export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/** Opens and immediately closes a TCP connection. ping -W means milliseconds on macOS, so it is not used. */
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

export async function isOnline(probe: TcpProbe = tcpProbe): Promise<boolean> {
  return (await probe("1.1.1.1", 443, 2000)) || (await probe("8.8.8.8", 53, 2000));
}
