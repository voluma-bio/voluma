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
 * does not mount (a checker's cited worker scratch); the adapter then reads the file itself.
 * Content addressing, not tamper-proofing: the agent writes the bytes anyway.
 */
import type { EvidenceRef } from "@voluma/contracts/output";

export interface Evidence {
  /** Rejects if the file does not exist; nothing is stored then. */
  keep(
    runId: string,
    taskId: string,
    file: Pick<EvidenceRef, "root" | "path">,
    hash?: () => Promise<string>,
  ): Promise<string>;
}
