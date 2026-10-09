export interface HolderOptions {
  /** Also keep the display on. */
  display: boolean;
  /** Holder must die when this pid dies (the daemon). */
  ownerPid: number;
}

export interface Holder {
  /** Pid of the helper process that owns the sleep assertion. */
  pid: number;
}

export type ReleaseResult = "released" | "gone" | "skipped";

/** Keeps the system from idle-sleeping for as long as the holder lives. */
export interface PowerPort {
  acquire(opts: HolderOptions): Promise<Holder>;
  /**
   * Kills the holder only after checking its command line looks like ours and
   * that it is tied to `ownerPid`. Returns false when the check failed and
   * nothing was killed (the recorded pid was probably reused).
   * 'released' = killed it, 'gone' = the pid no longer exists (nothing to
   * report), 'skipped' = something else lives at that pid and was left alone.
   */
  release(holder: { pid: number; ownerPid: number }): Promise<ReleaseResult>;
}
