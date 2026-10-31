/**
 * Interfaces both API domains depend on: what one domain reads from the other (index.ts
 * wires it; a domain never imports the other). Blob storage is `ObjectStore` from
 * `@voluma/object-store`, built by index.ts.
 * The run domain's event-log and history ports are derived from its Postgres adapters
 * (`pg-event-log.ts`, `pg-history.ts`); the Sandbox port lives in packages/harness, since the
 * runner, not the API, creates sandboxes. A refusal is an `HTTPException` thrown where it is
 * decided; a port method returns its success shape only.
 * A domain's own adapters live in the domain; adapters shared by domains go in
 * adapters/. Only index.ts constructs adapters.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { PersonMessage } from "@voluma/contracts/messages";
import type { reviewState } from "@voluma/contracts/review-state";
import type { Run } from "@voluma/contracts/run";
import type { ReviewSnapshot } from "@voluma/contracts/snapshot";
import type { Caller, Reader } from "../domain";

/** Immutable screenshots; writes require the same run lifetime to still exist. */
export type ReviewSnapshots = {
  find(runId: string, generation: string, id: string): Promise<ReviewSnapshot | null>;
  list(runId: string, generation: string): Promise<ReviewSnapshot[]>;
  insert(
    snapshot: ReviewSnapshot,
    generation: string,
  ): Promise<{ snapshot: ReviewSnapshot; created: boolean }>;
};

export type RunRecord = {
  /** Opaque run lifetime; changes when an example is replaced under the same id. */
  generation: string;
  run: Run;
  events: RunEvent[];
  results: ReturnType<typeof reviewState>;
};
/** Only authenticated human decisions can cross the review write port. */
export type ReviewDecision =
  | Pick<Extract<RunEvent, { type: "check.accepted" }>, "type" | "payload">
  | Pick<Extract<RunEvent, { type: "review.completed" }>, "type" | "payload">;

/** Run-owned coherent reads and serialized human writes; Review owns decision policy. */
export type RunRecords = {
  /** The run and every stored event, in `seq` order; null when `reader` can't read the run. */
  load(reader: Reader, runId: string): Promise<RunRecord | null>;
  /** Validate against the locked current record; append one decision or return it unchanged. */
  decide(
    reader: Reader,
    runId: string,
    decision: (record: RunRecord) => ReviewDecision | null,
  ): Promise<RunRecord | null>;
  /** The run's `generation` when `reader` can read it, else null; reads no log. */
  readable(reader: Reader, runId: string): Promise<{ generation: string } | null>;
};

export type MessageSent = {
  /** The stored `person.message` event. */
  eventId: string;
  /** The run's state after the message. */
  state: Run["state"];
  /** The caller sent this message id before: nothing was stored. */
  duplicate: boolean;
};

/**
 * A researcher's message to a run, which the Run domain stores and answers for
 * (`contracts/messages.ts`: who may send, the reopen). A refusal is an `HTTPException` with the
 * contract's status and text. Review parses the request and stores the snapshot.
 */
export type RunMessages = {
  /** Judges the message without storing anything, so a refused one leaves no snapshot behind. */
  check(
    reader: Reader,
    caller: Caller,
    runId: string,
    msg: { id: string; payload: PersonMessage },
  ): Promise<MessageSent>;
  /** Judges again under the queue lock and stores it, reopening a finished run. */
  send(
    reader: Reader,
    caller: Caller,
    runId: string,
    msg: { id: string; payload: PersonMessage },
  ): Promise<MessageSent>;
};
