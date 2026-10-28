/**
 * Postgres adapter for the RunQueue port: the claim, the lease and the recovery
 * (`@voluma/contracts/runner`). Every decision is made inside one transaction, under
 * the queue lock, judged by the database's `now()`; no API process's clock or memory
 * decides a lease. The lease token stays on an ended run so the old holder's next
 * heartbeat is told to `stop`; a recovery clears it, so that holder is `lease-lost`.
 */
import { randomBytes } from "node:crypto";
import { LEASE_SECONDS } from "@voluma/contracts/runner";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { runningCount, spentToday, startedToday } from "./pg-limits";
import { loadRun, QUEUE_LOCK, type Tx } from "./run-rows";
import { type Claimed, LeaseLost, type Limits, RunEnded, type RunQueue } from "./run-store";
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

export function pgRunQueue(db: PostgresJsDatabase, limitsOf: (labId: string) => Limits): RunQueue {
  return {
    claim: (runnerId, keyedRunIds) =>
      db.transaction(async (tx): Promise<Claimed | null> => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
        await sweep(tx);
        const keyed = new Set(keyedRunIds);
        const queued = await tx
          .select()
          .from(runs)
          .where(eq(runs.state, "queued"))
          .orderBy(asc(runs.createdAt), asc(runs.id));
        for (const run of queued) {
          if (run.credentials === "visitor") {
            if (!keyed.has(run.id)) continue;
          } else {
            const limits = limitsOf(run.labId);
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
            if (
              limits.concurrent !== null &&
              (await runningCount(tx, run.labId)) >= limits.concurrent
            ) {
              continue;
            }
          }
          const leaseToken = randomBytes(24).toString("hex");
          await tx
            .update(runs)
            .set({
              state: "running",
              startedAt: sql`coalesce(${runs.startedAt}, now())`,
              leaseHolder: runnerId,
              leaseToken,
              leaseExpiresAt: leaseUntil,
            })
            .where(eq(runs.id, run.id));
          return { run: await loadRun(tx, run.id), workflowId: run.workflowId, leaseToken };
        }
        return null;
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
        await tx
          .update(runs)
          .set({
            leaseExpiresAt: leaseUntil,
            modelCostUsd: sql`${runs.modelCostUsd} + ${usage.modelCostUsd}`,
            sandboxSeconds: sql`${runs.sandboxSeconds} + ${usage.sandboxSeconds}`,
          })
          .where(eq(runs.id, runId));
        const ceiling = limitsOf(run.labId).usdPerDay;
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

    async holdUnkeyedVisitorRuns() {
      await db.execute(sql`
        UPDATE runs SET state = 'awaiting-keys', awaiting_since = now()
        WHERE state = 'queued' AND credentials = 'visitor'`);
    },
  };
}
