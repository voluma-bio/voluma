/** Review presentation model, not a shared Run/API contract. No fixture data is supplied. */
import { z } from "zod";

export const assetSchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  url: z.string().url().nullable(),
  unavailableReason: z.string().nullable(),
});
export const measurementSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.number().finite().nullable(),
  unit: z.string(),
  status: z.enum(["provisional", "candidate"]),
  origin: z.enum(["measured", "unavailable"]),
  evidenceIds: z.array(z.string()),
  references: z.array(z.object({ reader: z.string(), value: z.number() })),
});
export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  ask: z.string(),
  dependsOn: z.array(z.string()),
  structureIds: z.array(z.string()),
  // Unchanged tasks retain their result identity across run snapshots.
  resultRevisionId: z.string(),
  actions: z.array(z.string()),
  checker: z.object({
    verdict: z.enum(["passed", "needs-review"]),
    text: z.string(),
  }),
  measurements: z.array(measurementSchema),
  checks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string(),
      status: z.enum(["open", "accepted"]),
    }),
  ),
  evidence: z.array(assetSchema),
  files: z.array(assetSchema),
  messages: z.array(
    z.object({
      id: z.string(),
      role: z.enum(["user", "assistant"]),
      text: z.string(),
    }),
  ),
});
export const structureSchema = z.object({
  id: z.string(),
  name: z.string(),
  declared: z.boolean(),
  status: z.enum(["done", "provisional", "missing"]),
  reason: z.string(),
});
export const revisionSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  tasks: z.array(taskSchema),
  structures: z.array(structureSchema),
});
export const reviewRunSchema = z.object({
  id: z.string(),
  sample: z.string(),
  workflow: z.string(),
  workflowVersion: z.string(),
  revisions: z.array(revisionSchema).min(1),
  record: z.array(
    z.object({
      id: z.string(),
      revisionId: z.string(),
      taskId: z.string().nullable(),
      text: z.string(),
      at: z.string(),
    }),
  ),
});
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

export type Asset = z.infer<typeof assetSchema>;
export type Measurement = z.infer<typeof measurementSchema>;
export type ReviewTask = z.infer<typeof taskSchema>;
export type Structure = z.infer<typeof structureSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export type ReviewRun = z.infer<typeof reviewRunSchema>;
export type CorrectionRequest = z.infer<typeof correctionRequestSchema>;
export type CorrectionProposal = z.infer<typeof correctionProposalSchema>;
