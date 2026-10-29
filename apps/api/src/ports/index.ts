/**
 * Interfaces both API domains depend on: what one domain reads from the other (index.ts
 * wires it; a domain never imports the other), and shared adapters such as blob storage.
 * The run domain's EventLog and History ports live in packages/harness, which the Node
 * runner shares; the Sandbox port too, since the runner, not the API, creates sandboxes.
 * A domain's own adapters live in the domain; adapters shared by domains go in
 * adapters/ (none yet). Only index.ts constructs adapters.
 * Owned by both lanes; change in small PRs.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { reviewState } from "@voluma/contracts/review-state";
import type { Input, Run } from "@voluma/contracts/run";
import type { Reader } from "../domain";

/** Review reads inputs through the Run lane's scoped read adapter. */
export type ReviewInputs = { listInputs(reader: Reader): Promise<Input[]> };

/** The published reference archive; a version pins the bytes described by the lookup. */
export type ReferenceArchive = {
  head(signal: AbortSignal): Promise<{ byteLength: number; version: string }>;
  open(
    version: string,
    signal: AbortSignal,
  ): Promise<{ body: ReadableStream<Uint8Array>; byteLength: number }>;
};

export type RunRecord = {
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
  /** Whether `reader` can read the run, without reading its log. */
  readable(reader: Reader, runId: string): Promise<boolean>;
};

/** A run's content-addressed files (`evidenceKey`) and its converted review assets (`reviewAssetKey`). */
export type RunFiles = {
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
  /** Rejects with a 404 `HTTPException` when there is no such file, a 502 when storage fails. */
  open(
    runId: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<{ body: ReadableStream<Uint8Array>; byteLength: number }>;
};
