/**
 * Pure reducer. The runner feeds it one observation per tick and executes the
 * effects it returns; nothing in here touches the OS or the clock.
 */

export type HotspotPhase = "idle" | "connecting" | "connected";

export interface MonitorState {
  /** We currently hold the sleep assertion. */
  awake: boolean;
  /**
   * idle: online or not applicable. connecting: offline, join attempts running.
   * connected: an attempt was followed by a working internet check. macOS 15+
   * redacts SSIDs, so "online again" is the only proof we have.
   */
  hotspot: HotspotPhase;
  /** --for deadline passed; the loop should stop. */
  expired: boolean;
}

export interface MonitorConfig {
  always: boolean;
  hotspot: string | null;
  /** Epoch ms after which --always stops by itself; null = never. */
  expiresAt: number | null;
}

export interface Observation {
  /** Labels of detected agents. Still collected in --always mode, for status output. */
  agents: string[];
  /** null = not checked this tick (no hotspot configured). */
  online: boolean | null;
  now: number;
}

export type AwakeReason = "always" | "agents";

export type Effect =
  | { type: "acquire"; reason: AwakeReason; agents: string[] }
  | { type: "release"; reason: "agents-gone" | "expired" }
  | { type: "connect-hotspot"; ssid: string; firstAttempt: boolean }
  | { type: "hotspot-restored"; ssid: string }
  | { type: "expire" };

export const initialState: MonitorState = { awake: false, hotspot: "idle", expired: false };

export function step(state: MonitorState, obs: Observation, cfg: MonitorConfig): { state: MonitorState; effects: Effect[] } {
  if (state.expired) return { state, effects: [] };

  const effects: Effect[] = [];

  if (cfg.expiresAt !== null && obs.now >= cfg.expiresAt) {
    if (state.awake) effects.push({ type: "release", reason: "expired" });
    effects.push({ type: "expire" });
    return { state: { awake: false, hotspot: "idle", expired: true }, effects };
  }

  const wantAwake = cfg.always || obs.agents.length > 0;
  let { awake, hotspot } = state;

  if (wantAwake && !awake) {
    effects.push({ type: "acquire", reason: cfg.always ? "always" : "agents", agents: obs.agents });
    awake = true;
  } else if (!wantAwake && awake) {
    effects.push({ type: "release", reason: "agents-gone" });
    awake = false;
    hotspot = "idle";
  }

  // The hotspot is only worth chasing while we are keeping the machine awake.
  if (awake && cfg.hotspot !== null && obs.online !== null) {
    if (!obs.online) {
      effects.push({ type: "connect-hotspot", ssid: cfg.hotspot, firstAttempt: hotspot !== "connecting" });
      hotspot = "connecting";
    } else if (hotspot === "connecting") {
      effects.push({ type: "hotspot-restored", ssid: cfg.hotspot });
      hotspot = "connected";
    }
  }

  return { state: { awake, hotspot, expired: false }, effects };
}
