import { initialState, step, type Effect, type MonitorConfig, type MonitorState, type Observation } from "./monitor.js";

/** Resolves after `ms`, or immediately when `signal` aborts. Never rejects. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RunnerDeps {
  config: MonitorConfig;
  intervalMs: number;
  signal: AbortSignal;
  observe(): Promise<Omit<Observation, "now">>;
  execute(effect: Effect, state: MonitorState): Promise<void>;
  /** Called when observe/execute throws. Without it the error ends the loop. */
  onError?(err: unknown): void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * observe -> step -> execute -> sleep. Returns the last state when the signal
 * aborts or the --for deadline passes. Releasing the holder on exit is the
 * caller's job (lifecycle cleanup), not the loop's.
 */
export async function runLoop(deps: RunnerDeps): Promise<MonitorState> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  let state = initialState;

  while (!deps.signal.aborted && !state.expired) {
    try {
      const obs = { ...(await deps.observe()), now: now() };
      const next = step(state, obs, deps.config);
      state = next.state;
      for (const effect of next.effects) await deps.execute(effect, state);
    } catch (e) {
      if (!deps.onError) throw e;
      deps.onError(e);
    }
    if (state.expired) break;
    await sleep(deps.intervalMs, deps.signal);
  }
  return state;
}
