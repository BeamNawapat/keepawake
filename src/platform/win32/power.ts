import type { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { Exec } from "../../ports/exec.js";
import type { Holder, HolderOptions, PowerPort } from "../../ports/power.js";
import { encodedCommandArgs } from "./powershell.js";

/** The slice of ChildProcess the holder needs, so tests can fake it. */
export interface HolderChild extends EventEmitter {
  pid?: number;
  stdin: { end(): void } | null;
}
export type SpawnHolder = (cmd: string, args: string[]) => HolderChild;

const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x1;
const ES_DISPLAY_REQUIRED = 0x2;

const realSpawn: SpawnHolder = (cmd, args) =>
  spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });

/**
 * Flags are written as decimal: PowerShell reads 0x80000001 as a negative
 * Int32, which does not convert to the uint32 parameter.
 */
export function holderScript(display: boolean): string {
  const flags = (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | (display ? ES_DISPLAY_REQUIRED : 0)) >>> 0;
  return [
    "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    "Add-Type -MemberDefinition $sig -Name Native -Namespace KeepAwake",
    `[void][KeepAwake.Native]::SetThreadExecutionState(${flags})`,
    // The assertion belongs to this thread, so it must stay parked here.
    // ReadLine returns null at stdin EOF, which is how we learn the daemon is gone.
    "while ($null -ne [Console]::In.ReadLine()) {}",
    `[void][KeepAwake.Native]::SetThreadExecutionState(${ES_CONTINUOUS >>> 0})`,
  ].join("\n");
}

export function createWin32Power(exec: Exec, spawnHolder: SpawnHolder = realSpawn): PowerPort {
  const children = new Map<number, HolderChild>();
  return {
    // opts.ownerPid is unused: when the daemon dies, Windows closes the pipe
    // and the holder sees EOF, so no pid watching is needed.
    async acquire(opts: HolderOptions): Promise<Holder> {
      const child = spawnHolder("powershell.exe", encodedCommandArgs(holderScript(opts.display)));
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      if (child.pid === undefined) throw new Error("power holder started without a pid");
      children.set(child.pid, child);
      return { pid: child.pid };
    },
    async release(holder: Holder): Promise<void> {
      const child = children.get(holder.pid);
      children.delete(holder.pid);
      // Closing stdin lets the script reset ES_CONTINUOUS itself; taskkill covers a wedged one.
      child?.stdin?.end();
      await exec.run("taskkill", ["/PID", String(holder.pid), "/T", "/F"], { timeoutMs: 5000 });
    },
  };
}
