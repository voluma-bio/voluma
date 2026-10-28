/**
 * The run domain's own ports: the run store the browser routes use, the queue the
 * runner routes use, and the lease-checked event log and history. Their Postgres
 * adapters (`pg-*.ts`) are built by index.ts. Every read takes the caller's `Reader`
 * (domain.ts) and the adapter applies it once, so another org's run is just absent.
 */
import type { EventInput } from "@voluma/contracts/events";
import type { Input, Run } from "@voluma/contracts/run";
import type { Usage } from "@voluma/contracts/runner";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import type { Reader } from "../../domain";

/** What one org may do (`run.ts`, Limits). A null number is no limit. */
export type Limits = {
  perCaller: number | null;
  concurrent: number | null;
  perDay: number | null;
  usdPerDay: number | null;
  /** Visitor runs queued or running, per org: the cap at start and `/keys`. */
  visitorActive: number | null;
};

/** An event id already stored under another run. */
export class EventIdTaken extends Error {
  constructor() {
    super("event id belongs to another run");
  }
}

/** An org's limits, or null for one that is no longer configured (its runs are refused or stopped). */
export type LimitsOf = (labId: string) => Limits | null;

/** The write's lease token is stale, or the run is not running. The runner stops. */
export class LeaseLost extends Error {
  constructor() {
    super("lease lost");
  }
}

/** A report on a run that already ended: the first end wins. */
export class RunEnded extends Error {
  constructor() {
    super("run has ended");
  }
}

export type StartRefusal =
  | "no-input"
  | "unknown-org"
  | "per-caller"
  | "visitor-active"
  | "daily"
  | "dollar";

export interface RunStore {
  list(reader: Reader): Promise<Run[]>;
  get(reader: Reader, runId: string): Promise<Run | null>;
  listInputs(reader: Reader): Promise<Input[]>;
  /** Creates the run `queued`. Refuses an input the reader can't read and a limit already reached. */
  start(
    reader: Reader,
    caller: { userId: string },
    request: {
      /** Chosen by the route, so the visitor keys are in the vault before this commits. */
      id: string;
      workflowId: string;
      pins: WorkflowPin[];
      inputId: string;
      credentials: Run["credentials"];
    },
  ): Promise<{ run: Run } | { refused: StartRefusal }>;
  /** Ends the run `cancelled` at once. Example runs are read-only. */
  cancel(reader: Reader, runId: string): Promise<Run | "not-found" | "example">;
  /**
   * `awaiting-keys` → `queued`, for the run's own starter. Once the run qualifies, and
   * before it is queued, checks the visitor cap, then calls `holdKeys`; if that returns false the run stays as it was
   * and the answer is "full".
   */
  resume(
    reader: Reader,
    userId: string,
    runId: string,
    holdKeys: () => boolean,
  ): Promise<Run | "not-found" | "forbidden" | "conflict" | "visitor-active" | "full">;
  /** One reference-scan input per org, so a lab member can start a run on it. */
  ensureReferenceInputs(labIds: string[]): Promise<void>;
}

export type Claimed = { run: Run; workflowId: string; leaseToken: string };

/** `dropped`: visitor runs the claim left queued without claiming (moved or failed), whose keys the vault must forget. */
export type ClaimOutcome = { claimed: Claimed | null; dropped: string[] };

export type RunnerReport =
  | { kind: "ended"; outcome: "completed" | "failed"; error?: string }
  | { kind: "released" };

export interface RunQueue {
  /**
   * One transaction: sweep expired leases, send the queued visitor runs not in
   * `keyedRunIds()` (read under the queue lock) to `awaiting-keys` (this process doesn't hold their keys), then take
   * the oldest queued run of the org served longest ago that the limits allow.
   */
  claim(runnerId: string, keyedRunIds: () => string[]): Promise<ClaimOutcome>;
  /** Extends the lease and adds the usage; `stop` once the run has ended. Throws `LeaseLost`. */
  heartbeat(runId: string, leaseToken: string, usage: Usage): Promise<{ stop: boolean }>;
  /** Throws `LeaseLost` or `RunEnded`. */
  report(runId: string, leaseToken: string, report: RunnerReport): Promise<void>;
}

/** The event log the ingest route writes: the lease is checked in the append's transaction. */
export interface LeasedEventLog {
  /** Throws `LeaseLost`, or `EventIdTaken` for an id stored under another run. */
  append(event: EventInput, leaseToken: string): Promise<void>;
}

export interface LeasedHistory {
  load(runId: string, threadId: string, leaseToken: string): Promise<string[]>;
  appendMessage(
    runId: string,
    threadId: string,
    idx: number,
    message: string,
    leaseToken: string,
  ): Promise<void>;
}
