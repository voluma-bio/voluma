/**
 * Postgres adapter for the RunQueue port: the claim, the lease and the recovery
 * (`@voluma/contracts/runner`). Every decision is made inside one transaction, under
 * the queue lock, judged by the database's `now()`; no API process's clock or memory
 * decides a lease. The lease token stays on an ended run so the old holder's next
 * heartbeat is told to `stop`; a recovery clears it, so that holder is `lease-lost`.
 */
import { randomBytes } from "node:crypto";
import { LEASE_SECONDS } from "@voluma/contracts/runner";
import { and, asc, eq, notInArray, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { runningCount, spentToday, startedToday } from "./pg-limits";
import { loadRun, QUEUE_LOCK, type Tx } from "./run-rows";
import { type ClaimOutcome, LeaseLost, type LimitsOf, RunEnded, type RunQueue } from "./run-store";
import { runs } from "./schema";

/** Lease expiries with no `released` before a run ends `failed` (so a run that crashes the runner doesn't loop). */
const MAX_RECOVERIES = 3;
/** How long a visitor run waits for its keys. */
const KEYS_WAIT = sql`interval '24 hours'`;

const leaseUntil = sql`now() + make_interval(secs => ${LEASE_SECONDS})`;

/**
 * Takes the matching running runs back: a `voluma` run to `queued`, a `visitor` run to
 * `awaiting-keys` (its keys are gone). A counted recovery (an expired lease) is one more
 * toward `MAX_RECOVERIES`; a `released` run isn't counted.
 */
async function recover(tx: Tx, where: SQL, counted: boolean) {
  const exhausted = counted ? sql`recoveries + 1 >= ${MAX_RECOVERIES}` : sql`false`;
  await tx.execute(sql`
    UPDATE runs SET
      state = CASE WHEN ${exhausted} THEN 'ended' WHEN credentials = 'visitor' THEN 'awaiting-keys' ELSE 'queued' END,
      ended_at = CASE WHEN ${exhausted} THEN now() END,
      outcome = CASE WHEN ${exhausted} THEN 'failed' END,
      error = CASE WHEN ${exhausted} THEN 'The runner lost this run three times.' END,
      awaiting_since = CASE WHEN NOT (${exhausted}) AND credentials = 'visitor' THEN now() END,
      recoveries = recoveries + ${counted ? 1 : 0},
      lease_holder = NULL, lease_token = NULL, lease_expires_at = NULL
    WHERE state = 'running' AND ${where}`);
}

async function sweep(tx: Tx) {
  await recover(tx, sql`lease_expires_at <= now()`, true);
  await tx.execute(sql`
    UPDATE runs SET state = 'ended', outcome = 'failed', ended_at = now(),
      error = 'The keys were not resent within 24 hours.'
    WHERE state = 'awaiting-keys' AND awaiting_since <= now() - ${KEYS_WAIT}`);
}

const fail = (tx: Tx, runId: string, error: string) =>
  tx
    .update(runs)
    .set({ state: "ended", outcome: "failed", endedAt: sql`now()`, error })
    .where(eq(runs.id, runId));

export function pgRunQueue(db: PostgresJsDatabase, limitsOf: LimitsOf): RunQueue {
  return {
    claim: (runnerId, keyedRunIds) =>
      db.transaction(async (tx): Promise<ClaimOutcome> => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
        await sweep(tx);
        // The keys live in this process's memory. A queued visitor run whose keys it
        // doesn't hold (another process took the start, or it restarted) can't be claimed.
        // The ids are read under the lock: a start that holds its keys before it commits
        // is then either in this list or not yet queued.
        const dropped: string[] = [];
        const unkeyed = await tx
          .update(runs)
          .set({ state: "awaiting-keys", awaitingSince: sql`now()` })
          .where(
            and(
              eq(runs.state, "queued"),
              eq(runs.credentials, "visitor"),
              notInArray(runs.id, keyedRunIds()),
            ),
          )
          .returning({ id: runs.id });
        dropped.push(...unkeyed.map((run) => run.id));
        // Round-robin by org: the org claimed longest ago goes first (never claimed: first),
        // and within an org the oldest run, so one org's backlog can't starve another.
        const queued = await tx
          .select()
          .from(runs)
          .where(eq(runs.state, "queued"))
          .orderBy(
            sql`(SELECT max(o.claimed_at) FROM runs o WHERE o.lab_id = ${runs.labId}) ASC NULLS FIRST`,
            asc(runs.createdAt),
            asc(runs.id),
          );
        for (const run of queued) {
          const limits = limitsOf(run.labId);
          if (!limits) {
            await fail(tx, run.id, "This organization can no longer run work.");
            if (run.credentials === "visitor") dropped.push(run.id);
            continue;
          }
          // A visitor run skips the runs-at-once count, and the visitor cap was checked
          // when it was started or resumed.
          if (run.credentials === "voluma") {
            if (
              limits.concurrent !== null &&
              (await runningCount(tx, run.labId)) >= limits.concurrent
            ) {
              continue;
            }
            // The daily limit counts a run once, at its first claim; a recovery has passed it.
            if (
              run.startedAt === null &&
              limits.perDay !== null &&
              (await startedToday(tx, run.labId)) >= limits.perDay
            ) {
              await fail(tx, run.id, "The organization's daily run limit was reached.");
              continue;
            }
            if (
              limits.usdPerDay !== null &&
              (await spentToday(tx, run.labId)) >= limits.usdPerDay
            ) {
              await fail(tx, run.id, "The organization's daily spending limit was reached.");
              continue;
            }
          }
          const leaseToken = randomBytes(24).toString("hex");
          await tx
            .update(runs)
            .set({
              state: "running",
              startedAt: sql`coalesce(${runs.startedAt}, now())`,
              claimedAt: sql`now()`,
              leaseHolder: runnerId,
              leaseToken,
              leaseExpiresAt: leaseUntil,
            })
            .where(eq(runs.id, run.id));
          return {
            claimed: { run: await loadRun(tx, run.id), workflowId: run.workflowId, leaseToken },
            dropped,
          };
        }
        return { claimed: null, dropped };
      }),

    heartbeat: (runId, leaseToken, usage) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
        const [run] = await tx
          .select()
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.leaseToken, leaseToken)))
          .for("update");
        if (!run) throw new LeaseLost();
        if (run.state !== "running") return { stop: true };
        const limits = limitsOf(run.labId);
        if (!limits) {
          await fail(tx, runId, "This organization can no longer run work.");
          return { stop: true };
        }
        await tx
          .update(runs)
          .set({
            leaseExpiresAt: leaseUntil,
            modelCostUsd: sql`${runs.modelCostUsd} + ${usage.modelCostUsd}`,
            sandboxSeconds: sql`${runs.sandboxSeconds} + ${usage.sandboxSeconds}`,
          })
          .where(eq(runs.id, runId));
        const ceiling = limits.usdPerDay;
        if (
          run.credentials === "voluma" &&
          ceiling !== null &&
          (await spentToday(tx, run.labId)) >= ceiling
        ) {
          await fail(tx, runId, "The organization's daily spending limit was reached.");
          return { stop: true };
        }
        return { stop: false };
      }),

    report: (runId, leaseToken, report) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
        const [run] = await tx
          .select({ state: runs.state })
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.leaseToken, leaseToken)))
          .for("update");
        if (!run) throw new LeaseLost();
        if (run.state !== "running") throw new RunEnded();
        if (report.kind === "released") {
          await recover(tx, sql`id = ${runId}`, false);
          return;
        }
        await tx
          .update(runs)
          .set({
            state: "ended",
            outcome: report.outcome,
            endedAt: sql`now()`,
            error: report.error ?? null,
          })
          .where(eq(runs.id, runId));
      }),
  };
}
