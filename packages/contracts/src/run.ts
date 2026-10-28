/**
 * The run record and the calls on it, under `/api/run` (cookie-authenticated;
 * the rules in `auth.ts` apply).
 *
 *   POST /api/run/runs             body `startRunRequestSchema` → 200 `runSchema`
 *                                  (429 when the org's daily spend cap is reached)
 *   GET  /api/run/runs             → 200 `listRunsResponseSchema`, newest first
 *   GET  /api/run/runs/:id         → 200 `runSchema`
 *   POST /api/run/runs/:id/cancel  → 200 `runSchema`; cancelling an ended run is a no-op
 *   GET  /api/run/inputs           → 200 `listInputsResponseSchema`, newest first
 *
 * Org scoping, enforced by the server on every call and every read:
 *   - Every read is filtered by the caller's `labId`. Another org's run or
 *     input answers 404, never 403.
 *   - When the caller's server-side scope is `self` (not in `meResponseSchema`),
 *     reads are also filtered to the caller: a run by `startedBy`, an input by
 *     `uploadedBy`, each equal to the caller's `userId`. Scope `lab` sees the org.
 *   - Run-scoped records (events, corrections) inherit `labId` from their run
 *     and do not repeat it; read access to them is read access to the run.
 *
 * Queue: the server may limit an org to one active run. `startRun` then
 * returns `queued` while another run is active, else `running`.
 *
 * Spend cap: enforced by the server from its own accounting, so the run record
 * carries no cost fields.
 */
import { z } from "zod";
import { userIdSchema } from "./auth";
import { runIdSchema, storedPrefixSchema } from "./r2";
import { workflowPinSchema } from "./workflow";

/**
 * A scan a run reads. `prefix` is the folder of files under a run's inputs
 * (`inputsPrefix`) or the reference scan, so it is mountable as-is. The upload
 * mechanism that creates inputs is a later PR; this PR only names its result.
 */
export const inputSchema = z.object({
  id: z.string(),
  prefix: storedPrefixSchema,
  uploadedBy: userIdSchema,
  name: z.string(),
});
export type Input = z.infer<typeof inputSchema>;

export const runStateSchema = z.discriminatedUnion("status", [
  /** `position` counts queued runs ahead of the next one to start: 1 is next. */
  z.object({ status: z.literal("queued"), position: z.number().int().min(1) }),
  z.object({ status: z.literal("running"), startedAt: z.iso.datetime() }),
  z.object({
    status: z.literal("ended"),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    endedAt: z.iso.datetime(),
    /** Why a `failed` run failed; absent otherwise. */
    error: z.string().optional(),
  }),
]);
export type RunState = z.infer<typeof runStateSchema>;

export const runSchema = z.object({
  id: runIdSchema,
  labId: z.string(),
  startedBy: userIdSchema,
  /** Pinned workflow packages, as in `r2.ts`'s `workflowPrefix`. */
  workflow: z.array(workflowPinSchema).min(1),
  input: inputSchema,
  createdAt: z.iso.datetime(),
  state: runStateSchema,
});
export type Run = z.infer<typeof runSchema>;

export const startRunRequestSchema = z.object({
  workflow: z.array(workflowPinSchema).min(1),
  inputId: z.string(),
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

export const listRunsResponseSchema = z.object({ runs: z.array(runSchema) });
export const listInputsResponseSchema = z.object({ inputs: z.array(inputSchema) });
