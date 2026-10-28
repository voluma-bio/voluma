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
};

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

export type StartRefusal = "no-input" | "per-caller" | "daily" | "dollar";

export interface RunStore {
  list(reader: Reader): Promise<Run[]>;
  get(reader: Reader, runId: string): Promise<Run | null>;
  listInputs(reader: Reader): Promise<Input[]>;
  /** Creates the run `queued`. Refuses an input the reader can't read and a limit already reached. */
  start(
    reader: Reader,
    caller: { userId: string },
    request: {
      workflowId: string;
      pins: WorkflowPin[];
      inputId: string;
      credentials: Run["credentials"];
    },
  ): Promise<{ run: Run } | { refused: StartRefusal }>;
  /** Ends the run `cancelled` at once. Example runs are read-only. */
  cancel(reader: Reader, runId: string): Promise<Run | "not-found" | "example">;
  /** `awaiting-keys` → `queued`, for the run's own starter. */
  resume(
    reader: Reader,
    userId: string,
    runId: string,
  ): Promise<Run | "not-found" | "forbidden" | "conflict">;
  /** One reference-scan input per org, so a lab member can start a run on it. */
  ensureReferenceInputs(labIds: string[]): Promise<void>;
}

export type Claimed = { run: Run; workflowId: string; leaseToken: string };

export type RunnerReport =
  | { kind: "ended"; outcome: "completed" | "failed"; error?: string }
  | { kind: "released" };

export interface RunQueue {
  /**
   * One transaction: sweep expired leases, then take the oldest queued run the limits
   * allow. A visitor run is eligible only while `keyedRunIds` holds it.
   */
  claim(runnerId: string, keyedRunIds: string[]): Promise<Claimed | null>;
  /** Extends the lease and adds the usage; `stop` once the run has ended. Throws `LeaseLost`. */
  heartbeat(runId: string, leaseToken: string, usage: Usage): Promise<{ stop: boolean }>;
  /** Throws `LeaseLost` or `RunEnded`. */
  report(runId: string, leaseToken: string, report: RunnerReport): Promise<void>;
  /** On API start: the keys are gone, so every unclaimed visitor run waits for them. */
  holdUnkeyedVisitorRuns(): Promise<void>;
}

/** The event log the ingest route writes: the lease is checked in the append's transaction. */
export interface LeasedEventLog {
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
