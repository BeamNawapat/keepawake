import type { LidPort, LidSnapshot } from "../../ports/lid.js";

/**
 * Nothing to snapshot: the lid inhibitor lives inside the holder process
 * (handle-lid-switch), so it disappears when the holder is released.
 */
export function createLinuxLid(): LidPort {
  return {
    async snapshot(): Promise<LidSnapshot> {
      return { kind: "linux" };
    },
    async set() {},
    async restore() {},
  };
}
