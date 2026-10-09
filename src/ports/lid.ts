/** Platform-specific snapshot of the setting we changed, stored in state.json. */
export type LidSnapshot =
  | { kind: "darwin"; sleepDisabled: string }
  | { kind: "win32"; scheme: string; ac: string; dc: string }
  | { kind: "linux" };

/**
 * Split into snapshot + set so the caller can write the snapshot to state.json
 * BEFORE touching the system setting. A crash between the two then still leaves
 * the restore value on disk.
 */
export interface LidPort {
  /** Read the current value without changing anything. */
  snapshot(): Promise<LidSnapshot>;
  /** Apply "keep running with the lid closed". May prompt for sudo/UAC. */
  set(snapshot: LidSnapshot): Promise<void>;
  /** Put back what `snapshot` recorded. May prompt again. */
  restore(snapshot: LidSnapshot): Promise<void>;
}
