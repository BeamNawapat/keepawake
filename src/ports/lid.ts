/** Platform-specific snapshot of the setting we changed, stored in state.json. */
export type LidSnapshot =
  | { kind: "darwin"; sleepDisabled: string }
  | { kind: "win32"; scheme: string; ac: string; dc: string }
  | { kind: "linux" };

export interface LidPort {
  /** Read the current value and apply "keep running with the lid closed". May prompt for sudo/UAC. */
  apply(): Promise<LidSnapshot>;
  /** Put back what `apply` recorded. May prompt again. */
  restore(snapshot: LidSnapshot): Promise<void>;
}
