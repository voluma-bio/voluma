/** What the host passes the loop: a thread's model setup and the run's tuning, with its defaults. */
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

/** What the host decides about a thread's model; the loop adds the prompts, identity and tools. */
export interface ModelSetup {
  model: Model<Api>;
  /** The Pi agent's thinking level, which Pi sends as `reasoning` and records on each reply. */
  thinkingLevel: ThinkingLevel;
  streamFn: StreamFn;
}

export interface LoopConfig {
  /** Deliveries with no notice in a row before code ends the run. */
  stuckLimit: number;
  /** Minutes an agent may work without an `activity` line before it is reminded. */
  activityMinutes: number;
  /** Minutes an agent may sit idle before it is pinged. */
  pingMinutes: number;
  /** Minutes idle before two pings in a row close a worker, whatever the ping interval. */
  pingCloseMinutes: number;
}

export const LOOP_DEFAULTS: LoopConfig = {
  stuckLimit: 2,
  activityMinutes: 10,
  pingMinutes: 25,
  pingCloseMinutes: 50,
};
