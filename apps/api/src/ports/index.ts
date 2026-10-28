/**
 * Interfaces the composition root wires between domains and their adapters.
 * The run domain's EventLog and History ports live in packages/harness, which the Node
 * runner shares; the Sandbox port too, since the runner, not the API, creates sandboxes.
 * A domain's own adapters live in the domain; adapters shared by domains go in
 * adapters/ (none yet). Only index.ts constructs adapters.
 * Owned by both lanes; change in small PRs.
 */
import type { Input } from "@voluma/contracts/run";
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
