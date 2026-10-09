export type CleanupFn = () => void | Promise<void>;

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Runs `fn` exactly once on SIGINT/SIGTERM/SIGHUP, uncaught exceptions and
 * process exit. Signal paths can await async work and then exit; the plain
 * "exit" path can only run synchronous work, so cleanup that must always
 * happen should do its sync part first.
 * Returns a disposer that removes the handlers (used by tests).
 */
export function installCleanup(fn: CleanupFn, proc: NodeJS.Process = process): () => void {
  let started = false;
  const run = async (): Promise<void> => {
    if (started) return;
    started = true;
    try {
      await fn();
    } catch (e) {
      proc.stderr.write(`cleanup failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };

  const onSignal = (): void => {
    void run().then(() => proc.exit(0));
  };
  const onExit = (): void => {
    void run();
  };
  const onUncaught = (e: unknown): void => {
    proc.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    void run().then(() => proc.exit(1));
  };

  for (const s of SIGNALS) proc.on(s, onSignal);
  proc.on("exit", onExit);
  proc.on("uncaughtException", onUncaught);

  return () => {
    for (const s of SIGNALS) proc.off(s, onSignal);
    proc.off("exit", onExit);
    proc.off("uncaughtException", onUncaught);
  };
}
