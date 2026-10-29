/**
 * The review's data is the shared contract (`@voluma/contracts/review`), loaded by
 * `getReviewRun`. Only the correction commands are local: their contract is still to come.
 */
import type { TaskStatus } from "@voluma/contracts/ids";
import type { StatusTone } from "@voluma/ui";
import { z } from "zod";

export type {
  Asset,
  Measurement,
  ReviewRun,
  ReviewTask,
  Revision,
  Score,
} from "@voluma/contracts/review";

export const correctionRequestSchema = z.object({
  runId: z.string(),
  baseRevisionId: z.string(),
  taskId: z.string(),
  instruction: z.string().trim().min(1).max(2000),
});
export const correctionProposalSchema = correctionRequestSchema.extend({
  id: z.string(),
  affectedTaskIds: z.array(z.string()),
});
export type CorrectionRequest = z.infer<typeof correctionRequestSchema>;
export type CorrectionProposal = z.infer<typeof correctionProposalSchema>;

/** A task status as its badge, with the run screen's labels and tones (`features/run/status.tsx`). */
export const taskStatus: Record<TaskStatus, { label: string; tone: StatusTone }> = {
  pending: { label: "Queued", tone: "neutral" },
  stale: { label: "Queued", tone: "neutral" },
  "in-progress": { label: "Running", tone: "info" },
  done: { label: "Done", tone: "primary" },
  failed: { label: "Failed", tone: "destructive" },
  "to-check": { label: "To check", tone: "check" },
  "under-review": { label: "Checking", tone: "info" },
};
