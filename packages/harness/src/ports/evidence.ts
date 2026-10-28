/**
 * The Evidence port: how a file an agent names (a checkpoint's evidence, a file or mesh in a
 * `report_output`) becomes stored evidence. `keep` copies the file to
 * `evidenceKey(runId, sha256)`, never overwriting, and returns the sha256 the event
 * records (`@voluma/contracts/task-tools`). `taskId` scopes an `outputs` path to
 * `outputKey(runId, taskId, path)`; a `scratch` path is under the run's scratch.
 */
import type { EvidenceRef } from "@voluma/contracts/output";

export interface Evidence {
  /** Rejects if the file does not exist; nothing is stored then. */
  keep(runId: string, taskId: string, file: Pick<EvidenceRef, "root" | "path">): Promise<string>;
}
