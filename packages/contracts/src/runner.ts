/**
 * The hand-off between the API and the runner, for both lanes. The runner is a
 * long-running service that claims runs from the API; these are the
 * bearer-authenticated ingest routes (`requireService`), not the browser's
 * `run.ts` calls. The state they move a run through is `runStateSchema`.
 *
 *   POST /api/run/ingest/claim                 body `claimRequestSchema` → 200 `claimResponseSchema`
 *   POST /api/run/ingest/runs/:id/heartbeat    body `leaseRequestSchema` → 200 `heartbeatResponseSchema`
 *   POST /api/run/ingest/runs/:id/report       body `reportRequestSchema` → 204
 *
 * Claim. The runner polls `claim` every `CLAIM_POLL_SECONDS` while it has a
 * free slot. Polling over long-polling because the API must look at the clock
 * anyway (expired leases, the daily limit checked at dequeue), a poll holds no
 * connection or in-memory wake-up on the API, and a run lasts minutes, so two
 * seconds of pickup delay costs nothing. `claim` is atomic: it picks the oldest
 * `queued` run the org's limits allow (and a `visitor` run only while the
 * server holds its keys), moves it to `running` with `startedAt` now, and takes
 * the lease for `runnerId`. Taking the run is what starts it, so the runner
 * reports no "running". `claim` answers `{ claim: null }` when there is
 * nothing to start. For a `visitor` run the response is the only place the
 * keys go and the server forgets them as it answers. A response lost on the
 * way costs that run its keys, which the lease below recovers like any other
 * lost keys.
 *
 * Lease. A claim is a lease on the run for `LEASE_SECONDS` from the server's
 * last heartbeat for it. Nothing runs twice at once because:
 *   - the server gives a run to another claim only after its lease expired
 *     (or the runner released it);
 *   - the runner stops the run itself, without waiting to be told, when it has
 *     not had a heartbeat acknowledged for `LEASE_SECONDS - HEARTBEAT_SECONDS`,
 *     measured from when it sent the last acknowledged heartbeat. That is
 *     earlier than the server's expiry whatever the network delay, and uses
 *     no shared clock;
 *   - every call below carries the `runnerId` and answers 409 when that runner
 *     doesn't hold the run's lease, and then the runner stops it at once.
 * When a lease expires, or the runner releases it, the run is recovered the
 * same way: a `voluma` run goes back to `queued`, ahead of newer runs; a
 * `visitor` run goes to `awaiting-keys`, because its keys are gone. The runner
 * keeps its `events` already written, and the next claim resumes the thread
 * from them. The plan in the claim is the workflow's current one; a resumed run
 * keeps the plan its first `revision.started` recorded (`task-tools.ts`). A run
 * the server has recovered three times ends `failed` instead, so one that
 * crashes the runner doesn't loop.
 *
 * Cancel. The runner learns a run is over from the heartbeat: `stop` is true
 * once the server has ended it (cancelled by the user, or `failed` by the
 * dollar ceiling). The runner stops its threads and sandboxes and reports
 * nothing more; the server has recorded the end already (`run.ts`).
 *
 * Reports. The runner ends the run with `ended`, or gives it up with
 * `released` (a shutdown, or lost keys). Either one ends the lease, and a
 * `released` run is recovered as above, at once. The runner's `ended` never
 * says `cancelled`, which is the server's to record. A report for a run the
 * runner no longer leases answers 409 and changes nothing.
 *
 * Keys. They are never stored, logged or echoed. An error body from these
 * routes names no request or response field, and the runner redacts the key
 * values from every error it reports (`run.ts`).
 */
import { z } from "zod";
import { runSchema, visitorKeysSchema } from "./run";
import { workflowPlanSchema } from "./workflow";

/** How long a run stays leased after the server's last heartbeat for it. */
export const LEASE_SECONDS = 60;
/** How often the runner heartbeats each run it holds. */
export const HEARTBEAT_SECONDS = 15;
/** How often an idle runner asks for a run. */
export const CLAIM_POLL_SECONDS = 2;

/**
 * Names one runner process: a fresh random string at each start, so a restarted
 * runner never inherits its predecessor's leases.
 */
export const runnerIdSchema = z.string().min(1);

export const claimRequestSchema = z.object({ runnerId: runnerIdSchema });
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const claimSchema = z
  .object({
    /** In state `running`. */
    run: runSchema,
    plan: workflowPlanSchema,
    /** Present exactly for a `visitor` run; returned once. */
    keys: visitorKeysSchema.optional(),
  })
  .refine((c) => (c.run.credentials === "visitor") === (c.keys !== undefined), {
    path: ["keys"],
    message: "keys go with a visitor run and no other",
  });
export type Claim = z.infer<typeof claimSchema>;

export const claimResponseSchema = z.object({ claim: claimSchema.nullable() });
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

/** The body of every call on a run the runner holds. */
export const leaseRequestSchema = z.object({ runnerId: runnerIdSchema });

export const heartbeatResponseSchema = z.object({
  /** The server has ended the run; stop it. */
  stop: z.boolean(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export const reportRequestSchema = z.object({
  runnerId: runnerIdSchema,
  report: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ended"),
      outcome: z.enum(["completed", "failed"]),
      /** Why a `failed` run failed, redacted of key values; absent otherwise. */
      error: z.string().optional(),
    }),
    /** The runner stops the run and gives up its lease: a shutdown, or lost keys. */
    z.object({ kind: z.literal("released") }),
  ]),
});
export type ReportRequest = z.infer<typeof reportRequestSchema>;
