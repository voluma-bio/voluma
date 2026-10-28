/**
 * The run record and the calls on it, under `/api/run`. These calls are
 * cookie-authenticated (the rules in `auth.ts` apply); the bearer-authenticated
 * ingest routes under the same prefix are a different contract.
 *
 *   POST /api/run/runs             body `startRunRequestSchema` → 200 `runSchema`
 *                                  (404 for an unknown `workflowId` or an `inputId`
 *                                  the caller can't read; 409 and 429: see Limits)
 *   GET  /api/run/runs             → 200 `listRunsResponseSchema`, newest first
 *   GET  /api/run/runs/:id         → 200 `runSchema`
 *   POST /api/run/runs/:id/cancel  → 200 `runSchema` with state `ended`/`cancelled`
 *                                  at once, even if the runner is still stopping (the
 *                                  server records it and the runner obeys); cancelling
 *                                  an ended run is a no-op; 403 for an example run
 *   POST /api/run/runs/:id/keys    body `resendKeysRequestSchema` → 200 `runSchema`
 *                                  (409 unless the run is `awaiting-keys`; 403 unless
 *                                  the caller is its `startedBy`; 429: see Limits)
 *   GET  /api/run/inputs           → 200 `listInputsResponseSchema`, newest first
 *
 * Org scoping, enforced by the server on every call and every read:
 *   - Every read is filtered by the caller's `labId`. Another org's run or
 *     input answers 404, never 403.
 *   - When the caller's server-side scope is `self` (not in `meResponseSchema`),
 *     reads are also filtered to the caller: a run when `startedBy` is the
 *     caller's `userId` or the run is an `example`; an input when `uploadedBy`
 *     is the caller or an example run reads it. Scope `lab` sees the org.
 *   - Example runs are read-only to everyone. Only server-side seeding (an
 *     operator script, under a dedicated operator id) sets `example`, never
 *     `startRun` or a fork, and it never changes afterwards; to change an
 *     example, re-seed it. A correction on one never changes it: the server
 *     creates the caller's own run with `forkedFrom` set (the corrections
 *     contract), which reads the same input. One caller has at most one fork
 *     per example; later corrections apply to it.
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
 * Starting work. The rules below hold for every call that creates a run or
 * makes one run again: `startRun`, a fork or a rerun after a correction (the
 * corrections contract), `/keys`, and any added later.
 *
 * Who pays (`credentials`): `visitor` when the request that creates the run
 * carries `keys`, else `voluma`. It never changes afterwards, and a `visitor`
 * run never falls back to Voluma's credentials.
 *
 * Visitor keys are the caller's own, kept in their browser. The server and the
 * runner hold them in memory for that run only: never in the database, on
 * disk, in logs or in any response (log no request body on these routes). The
 * only channel that carries them past the server is the hand-off to the runner
 * (the runner contract), which goes through no store. Text from a visitor's
 * providers (errors, SDK messages) has the key values redacted before it is
 * stored or logged. If the server or the runner loses the keys before the run
 * ends (a restart or a deploy), the run moves to `awaiting-keys` and resumes
 * when the browser resends them (`/keys`). After 24 h in `awaiting-keys` it
 * ends `failed` with an `error`. Both keys or none: a request with only one
 * fails validation (400). A `visitor` run's sandbox runs in the visitor's own
 * account, so its outputs are untrusted: never seed an example from one.
 *
 * Limits: each org has its own, given to the run domain by the API's
 * composition root:
 *   - per caller: at most this many runs that haven't ended, per `credentials`
 *     kind (none for an org whose members share one account); another answers
 *     409;
 *   - for `voluma` runs only: runs at once (a new one starts `queued` while the
 *     org is at it, else `running`), runs per day, and a dollar ceiling counted
 *     from the server's own accounting, so the run record carries no cost
 *     fields. The daily and dollar limits answer 429 when work starts and are
 *     checked again when a queued run is dequeued; a run refused at dequeue, or
 *     a running one that crosses the dollar ceiling, ends `failed` with an
 *     `error`.
 * A `visitor` run starts at once.
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
 * `r2.ts`. Under `self`, `listInputs` lists only the caller's uploads; an
 * example run's input is readable through the run, not listed.
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
  /** A `visitor` run whose keys the runner lost; it resumes when they're resent. */
  z.object({ status: z.literal("awaiting-keys"), startedAt: z.iso.datetime() }),
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
  /** Who pays for models and sandboxes; see the header. */
  credentials: z.enum(["voluma", "visitor"]),
  /**
   * A shared, read-only run every caller in the org can read, even under
   * `self`, set only by seeding (see the header). Its input reaches every
   * visitor, who can also start runs on it with their own sandbox, so an
   * example's scan must be cleared for public use.
   */
  example: z.boolean(),
  /** The example run this one was forked from by a correction on it; null for a fresh run. */
  forkedFrom: runIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  state: runStateSchema,
});
export type Run = z.infer<typeof runSchema>;

/**
 * A visitor's own credentials: a Meta Model API key and a Modal token. Sent
 * only in requests, never returned; see the header.
 */
export const visitorKeysSchema = z.object({
  metaApiKey: z.string().min(1),
  modal: z.object({ tokenId: z.string().min(1), tokenSecret: z.string().min(1) }),
});
export type VisitorKeys = z.infer<typeof visitorKeysSchema>;

export const startRunRequestSchema = z.object({
  workflowId: workflowIdSchema,
  inputId: inputIdSchema,
  /** Present: the run uses these and skips the queue (`credentials: "visitor"`). */
  keys: visitorKeysSchema.optional(),
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

export const listRunsResponseSchema = z.object({ runs: z.array(runSchema) });
export const listInputsResponseSchema = z.object({ inputs: z.array(inputSchema) });
export const resendKeysRequestSchema = z.object({ keys: visitorKeysSchema });
export type ResendKeysRequest = z.infer<typeof resendKeysRequestSchema>;
