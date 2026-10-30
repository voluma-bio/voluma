/**
 * Interfaces both API domains depend on: what one domain reads from the other (index.ts
 * wires it; a domain never imports the other), and shared adapters such as blob storage.
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

/** The published reference archive; a version pins the bytes described by the lookup. */
export type ReferenceArchive = {
  head(signal: AbortSignal): Promise<{ byteLength: number; version: string }>;
  open(
    version: string,
    signal: AbortSignal,
  ): Promise<{ body: ReadableStream<Uint8Array>; byteLength: number }>;
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

/** A run's content-addressed files (`evidenceKey`), its converted review assets (`reviewAssetKey`) and the snapshots researchers attach to messages. */
export type RunFiles = {
  /** Publish complete content-addressed bytes; rejects with 502 when storage fails. */
  put(runId: string, sha256: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /**
   * A short-lived URL for one converted asset of the run (`reviewAssetKey(runId, sha256,
   * path)`), with the seconds it stays valid for. The same file asked for again soon gets the
   * same URL (signed at a window's start), so the browser's cache can serve the repeat. The
   * object is immutable; storage tells the browser to cache it for a day. Does not check that
   * the object exists.
   */
  assetUrl(
    runId: string,
    sha256: string,
    path: string,
  ): Promise<{ url: string; validSeconds: number }>;
  /** Stores a researcher's view snapshot (`messageSnapshotKey`); the caller has checked it is a PNG. */
  putSnapshot(runId: string, messageId: string, png: Uint8Array): Promise<void>;
  /** A message's view snapshot (`messageSnapshotKey`); rejects like `open`. */
  openSnapshot(
    runId: string,
    messageId: string,
    signal: AbortSignal,
  ): Promise<{ body: ReadableStream<Uint8Array>; byteLength: number }>;
  /** Rejects with a 404 `HTTPException` when there is no such file, a 502 when storage fails. */
  open(
    runId: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<{ body: ReadableStream<Uint8Array>; byteLength: number }>;
};
