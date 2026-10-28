/**
 * The run record and the calls on it, under `/api/run`. These calls are
 * cookie-authenticated (the rules in `auth.ts` apply); the bearer-authenticated
 * ingest routes under the same prefix are a different contract.
 *
 *   POST /api/run/runs             body `startRunRequestSchema` → 200 `runSchema`
 *                                  (404 for an unknown `workflowId` or an `inputId`
 *                                  the caller can't read; 429 when the org's daily
 *                                  spend cap is reached)
 *   GET  /api/run/runs             → 200 `listRunsResponseSchema`, newest first
 *   GET  /api/run/runs/:id         → 200 `runSchema`
 *   POST /api/run/runs/:id/cancel  → 200 `runSchema` with state `ended`/`cancelled`
 *                                  at once, even if the runner is still stopping (the
 *                                  server records it and the runner obeys); cancelling
 *                                  an ended run is a no-op
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
 *     An input exists before any run and can serve several, so it carries its
 *     own `labId`.
 *   - `startRun` reads the input under the same rule: an `inputId` the caller
 *     can't read answers 404, so a visitor can't start a run on another
 *     visitor's input by guessing its id.
 *
 * Workflows: the request names a workflow from the server's catalog, never raw
 * pins, so a caller can't make the server import an arbitrary repo. The server
 * resolves the id to pinned packages and records them on the run.
 *
 * Queue: the server may limit an org to one active run. `startRun` then
 * returns `queued` while another run is active, else `running`.
 *
 * Spend cap: enforced by the server from its own accounting, so the run record
 * carries no cost fields. The server checks it at `startRun` and again when a
 * queued run is dequeued; a run refused at dequeue ends `failed` with an `error`.
 */
import { z } from "zod";
import { userIdSchema } from "./auth";
import { inputIdSchema, runIdSchema } from "./ids";
import { workflowPinSchema } from "./workflow";

/**
 * A scan a run reads. `source` says where its files are: an `upload` lives at
 * `inputPrefix(id)`; the `reference` scan is `referencePrefix("scan")`. The
 * server derives the R2 prefix; the browser never needs it. The upload call
 * that creates inputs is a later PR; its key layout (`inputKey`) is settled in
 * `r2.ts`. The reference input has no uploader rule yet, so a `self`-scoped
 * `listInputs` filtered by `uploadedBy` would not show it.
 */
export const inputSchema = z.object({
  id: inputIdSchema,
  labId: z.string(),
  source: z.enum(["upload", "reference"]),
  uploadedBy: userIdSchema,
  name: z.string(),
});
export type Input = z.infer<typeof inputSchema>;

/** A workflow in the server's catalog. */
export const workflowIdSchema = z.string().min(1);

export const runStateSchema = z.discriminatedUnion("status", [
  /**
   * 1-based place in the org's queue; 1 starts next. The server computes it at
   * read time and doesn't store it, so the run screen polls `getRun` to see it
   * move. Under `self`, it still counts other visitors' runs (only a count leaks).
   */
  z.object({ status: z.literal("queued"), position: z.number().int().min(1) }),
  z.object({ status: z.literal("running"), startedAt: z.iso.datetime() }),
  z.object({
    status: z.literal("ended"),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    /** Null when a queued run was cancelled before it started. */
    startedAt: z.iso.datetime().nullable(),
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
  /** The pins the server resolved from the request's `workflowId`, as in `r2.ts`'s `workflowPrefix`. */
  workflows: z.array(workflowPinSchema).min(1),
  input: inputSchema,
  createdAt: z.iso.datetime(),
  state: runStateSchema,
});
export type Run = z.infer<typeof runSchema>;

export const startRunRequestSchema = z.object({
  workflowId: workflowIdSchema,
  inputId: inputIdSchema,
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

export const listRunsResponseSchema = z.object({ runs: z.array(runSchema) });
export const listInputsResponseSchema = z.object({ inputs: z.array(inputSchema) });
