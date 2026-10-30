/**
 * The Evidence port: how a file an agent names (a checkpoint's evidence, a file or mesh in a
 * `report_output`) becomes stored evidence. `keep` copies the file to
 * `evidenceKey(runId, sha256)`, never overwriting, and returns the sha256 the event
 * records (`@voluma/contracts/task-tools`). `taskId` scopes an `outputs` path to
 * `outputKey(runId, taskId, path)`; a `scratch` path is under the run's scratch.
 *
 * The runtime hashes the file where it is mounted, in the calling thread's sandbox, and passes
 * `hash` so an adapter moves no file bytes through the host: it may skip the call when it
 * already knows the hash of unchanged bytes. `hash` is absent for a file the caller's sandbox
 * does not mount (a checker's cited worker scratch); the adapter then reads the file itself,
 * up to `MAX_UNMOUNTED_BYTES`: a larger one is refused.
 * Content addressing, not tamper-proofing: the agent writes the bytes anyway.
 */
import type { EvidenceRef } from "@voluma/contracts/output";

/** The largest file an adapter streams through the host itself (no `hash` given). */
export const MAX_UNMOUNTED_BYTES = 64 * 1024 * 1024;

/** The file cannot be kept, for a reason the agent can act on; the message is what it reads. */
export class EvidenceRefused extends Error {}

export interface Evidence {
  /**
   * Rejects with `EvidenceRefused` if the file does not exist or is too large to read without
   * `hash`; nothing is stored then. `signal` aborts the call.
   */
  keep(
    runId: string,
    taskId: string,
    file: Pick<EvidenceRef, "root" | "path">,
    options?: { hash?: () => Promise<string>; signal?: AbortSignal },
  ): Promise<string>;
}
