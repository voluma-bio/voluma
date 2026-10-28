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

/** The run domain's record of a run, for the review: the run and its whole event log. */
export type RunRecords = {
  /** The run and every stored event, in `seq` order; null when `reader` can't read the run. */
  load(reader: Reader, runId: string): Promise<{ run: Run; events: RunEvent[] } | null>;
  /** Whether `reader` can read the run, without reading its log. */
  readable(reader: Reader, runId: string): Promise<boolean>;
};

/** A run's content-addressed files (`evidenceKey`): evidence, data files, volumes, meshes. */
export type RunFiles = {
  /** Rejects with a 404 `HTTPException` when there is no such file, a 502 when storage fails. */
  open(
    runId: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<{ body: ReadableStream<Uint8Array>; byteLength: number }>;
};
