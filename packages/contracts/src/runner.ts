/**
 * The hand-off between the API and the runner, for both lanes. The runner is a
 * long-running service that claims runs from the API; these are the
 * bearer-authenticated ingest routes (`requireService`), not the browser's
 * `run.ts` calls. The state they move a run through is `runStateSchema`.
 *
 *   POST /api/run/ingest/claim                 body `claimRequestSchema` → 200 `claimResponseSchema`
 *   POST /api/run/ingest/runs/:id/heartbeat    body `heartbeatRequestSchema` → 200 `heartbeatResponseSchema`
 *   POST /api/run/ingest/runs/:id/report       body `reportRequestSchema` → 204
 *
 * Claim. The runner polls `claim` every `CLAIM_POLL_SECONDS` while it has a
 * free slot. Polling over long-polling because the API must look at the clock
 * anyway (expired leases, the daily limit checked at dequeue), a poll holds no
 * connection or in-memory wake-up on the API, and a run lasts minutes, so two
 * seconds of pickup delay costs nothing. Every run is created `queued` and
 * only a claim starts it (`run.ts`). `claim` is atomic: it picks the oldest
 * `queued` run the org's limits allow (a `visitor` run skips the runs-at-once
 * count, and is taken only while the server holds its keys), choosing across
 * orgs so one org's queue never holds another's back: among each org's oldest
 * claimable run, it takes the one whose org was claimed from least recently
 * (from the runs' stored claim times, never from an API process's memory);
 * ties go to the older run. It moves it to
 * `running`, and takes the lease. A run's `startedAt` is its first claim's
 * time; a re-claim keeps it, and the daily limit counts a run once. Taking the
 * run is what starts it, so the runner reports no "running". `claim` answers
 * `{ claim: null }` when there is nothing to start. For a `visitor` run the
 * response is the only place the keys go and the server forgets them as it
 * answers. A response lost on the way costs that run its keys, which the lease
 * below recovers like any other lost keys.
 *
 * Lease. A claim is a lease on the run for `LEASE_SECONDS` from the server's
 * last heartbeat for it. The holder (`runnerId`), the lease token, the expiry
 * and why the claim ended are columns of the run row. The expiry is judged
 * by the database's `now()` inside the claim's transaction, which is also where
 * expired leases are swept, so no API process's clock or memory decides it.
 * Every claim issues a new lease token (`leaseToken`). Every ingest call on
 * the run carries it in the `LEASE_TOKEN_HEADER` header: event and history
 * writes and reads, heartbeat and report. The server checks it inside the write's
 * own transaction (for events, under the same per-run lock that assigns `seq`)
 * and answers a stale token with 409 and `leaseLostSchema` (a request with no token is 400), so a
 * runner that lost its run can write nothing, however late its request lands.
 * The runner treats a `leaseLostSchema` 409 on any call as "stop now". (A
 * history append's own 409 for a taken `idx` has a different body.)
 * The runner also stops itself, as a courtesy that frees its sandboxes sooner:
 * when it has not had a heartbeat acknowledged for `LEASE_SECONDS -
 * HEARTBEAT_SECONDS`, measured from when it sent the last acknowledged
 * heartbeat. That is earlier than the server's expiry whatever the network
 * delay, and uses no shared clock. Once it can reach the API again it sends
 * `released` with its reason, so the run is recovered without waiting out the lease.
 * When a lease expires, or the runner releases it, the run is recovered the
 * same way: a `voluma` run goes back to `queued`, ahead of newer runs; a
 * `visitor` run goes to `awaiting-keys`, because its keys are gone. A release with reason
 * `awaiting-person` instead moves the run to `awaiting-person` ("Waiting on you"): it holds no
 * runner, and a person message (`messages.ts`) moves it to `queued`. The runner
 * keeps its `events` already written, and the next claim resumes the thread
 * from them. That claim carries `previousClaim.reason`, why the claim before it ended
 * (`claimEndReasonSchema`); the API records `lease-expired` itself when it sweeps a lease. The
 * claim carries no plan: the runner snapshots the run's workflow directory and builds the plan
 * itself (`packages/workflow`), and a resumed run keeps the plan its first `revision.started`
 * recorded (`task-tools.ts`). One limit stops a run that keeps costing its runner: the API
 * counts consecutive claims that end `self-stop` or `lease-expired` without run-state
 * progress (a `task`, `checkpoint`, `output`, `attempt.opened`, `assets.ready` or correcting
 * `revision.started` or `plan.changed` event), and the run ends
 * `failed` at 3, naming the call that was in flight. Progress resets the count. `shutdown`
 * never counts, so deploys don't fail a long run, and `awaiting-person` never counts either (a run
 * waiting on the researcher is not stalled); it does not reset the count. Appending a
 * `person.message` (`messages.ts`) resets it to 0: the event lands between claims, so the next
 * claim's progress window never contains it.
 *
 * There is no tokenless call: the runner service is the only claimer.
 *
 * Cancel. The runner learns a run is over from the heartbeat: `stop` is true
 * once the server has ended it (cancelled by the user, or `failed` by the
 * dollar ceiling). The runner stops its threads and sandboxes and reports
 * nothing more; the server has recorded the end already (`run.ts`). A cancel also ends
 * every open thread `cancelled` and the root last, in the same transaction (`cancelEnds` in
 * `threads.ts`): the runner's writes are refused once the run has ended, so the server writes
 * them, and a run cancelled while no runner holds it is left just as consistent.
 *
 * Usage. The heartbeat carries the usage since the previous acknowledged
 * heartbeat (`usageSchema`): the dollars of model calls and the seconds of
 * sandbox time. The server adds them up per run, and that sum is what the org's
 * dollar ceiling counts. A heartbeat the server did not acknowledge is resent
 * with its usage added to the next one. The runner sends `costCapUsd` (its
 * `RUNNER_MAX_RUN_COST_USD`) with the claim only when that is set, and the claim
 * stores it as the run's spend cap for the provider gateway to check. Unset, the
 * run has no cap. The heartbeat answers with `spentUsd`,
 * the run's settled spend including its provider calls, so the runner's own cap
 * sees spend that did not come through its heartbeats.
 *
 * Reports. The runner ends the run with `ended`, or gives it up with
 * `released` (a shutdown, a self-stop or `awaiting-person`: its `reason`). Either one ends the
 * lease, and a `released` run is recovered as above, at once. The runner's
 * `ended` never says `cancelled`, which is the server's to record. The first
 * end wins: a report on a run that has ended, or that this lease no longer
 * holds, changes nothing and answers 409.
 *
 * Keys. They are never stored, logged or echoed. An error body from these
 * routes names no request or response field, and the runner redacts the key
 * values from every error it reports (`run.ts`).
 */
import { z } from "zod";
import { runSchema, visitorKeysSchema } from "./run";

/** How long a run stays leased after the server's last heartbeat for it. */
export const LEASE_SECONDS = 60;
/** How often the runner heartbeats each run it holds. */
export const HEARTBEAT_SECONDS = 15;
/** How often an idle runner asks for a run. */
export const CLAIM_POLL_SECONDS = 2;

/** The header that carries the lease token on every ingest call on a run. */
export const LEASE_TOKEN_HEADER = "x-lease-token";

/** The body of the 409 for a stale lease token. */
export const leaseLostSchema = z.object({ code: z.literal("lease-lost") });

/**
 * Names one runner process: a fresh random string at each start, so a restarted
 * runner never inherits its predecessor's leases.
 */
export const runnerIdSchema = z.string().min(1);

/** Why the runner gave up a lease. */
export const releaseReasonSchema = z.enum([
  "shutdown",
  "self-stop",
  // The main agent waits only on the person (`messages.ts`): the run moves to `awaiting-person`
  // for every credentials kind, and a person message queues it again.
  "awaiting-person",
]);
export type ReleaseReason = z.infer<typeof releaseReasonSchema>;

/** Why a claim ended: a release reason, or the API swept its expired lease. */
export const claimEndReasonSchema = z.enum([
  ...releaseReasonSchema.options,
  "lease-expired",
  // Not an end but the cause of the next claim: a person message reopened the run (an ended
  // `completed` run, or an `awaiting-person` one). `claim.started.after` and `previousClaim.reason`
  // carry it on that claim.
  "person-message",
]);
export type ClaimEndReason = z.infer<typeof claimEndReasonSchema>;

export const claimRequestSchema = z.object({
  runnerId: runnerIdSchema,
  /**
   * The runner's `RUNNER_MAX_RUN_COST_USD`; the claim stores it as the run's spend cap, which
   * the provider gateway checks. Absent: no cap (spend is still recorded).
   */
  costCapUsd: z.number().positive().optional(),
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const claimSchema = z
  .object({
    /** In state `running`. */
    run: runSchema,
    /** Changes with every claim; see Lease. */
    leaseToken: z.string().min(1),
    /** Present exactly for a `visitor` run; returned once. */
    keys: visitorKeysSchema.optional(),
    /** Present on every claim after the run's first: why the previous claim ended. */
    previousClaim: z.object({ reason: claimEndReasonSchema }).optional(),
  })
  .refine((c) => (c.run.credentials === "visitor") === (c.keys !== undefined), {
    path: ["keys"],
    message: "keys go with a visitor run and no other",
  });
export type Claim = z.infer<typeof claimSchema>;

export const claimResponseSchema = z.object({ claim: claimSchema.nullable() });
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

/** Spend since the previous acknowledged heartbeat. */
export const usageSchema = z.object({
  /** Model calls, in US dollars. */
  modelCostUsd: z.number().nonnegative(),
  sandboxSeconds: z.number().nonnegative(),
});
export type Usage = z.infer<typeof usageSchema>;

export const heartbeatRequestSchema = z.object({ usage: usageSchema });
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const heartbeatResponseSchema = z.object({
  /** The server has ended the run; stop it. */
  stop: z.boolean(),
  /**
   * The run's known spend in US dollars: heartbeat-reported model cost, plus the cost of each
   * provider call that has one. A call cut off with no usage (cost unknown) and a call still
   * open count nothing. The same provider-call sum as `Run.providerCalls`. Optional until the
   * API sends it.
   */
  spentUsd: z.number().nonnegative().optional(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export const reportRequestSchema = z.object({
  report: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ended"),
      outcome: z.enum(["completed", "failed"]),
      /** Why a `failed` run failed, redacted of key values; absent otherwise. */
      error: z.string().optional(),
    }),
    /** The runner stops the run and gives up its lease: a shutdown or a self-stop. */
    z.object({
      kind: z.literal("released"),
      reason: releaseReasonSchema,
    }),
  ]),
});
export type ReportRequest = z.infer<typeof reportRequestSchema>;
