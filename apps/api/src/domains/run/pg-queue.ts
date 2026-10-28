/**
 * Postgres adapter for the run queue: every state change of a run, and the key vault
 * (key-vault.ts) that goes with it. Each transition (start, resume, cancel, claim,
 * heartbeat, report) runs in one transaction under the queue lock, judged by the
 * database's `now()`; no API process's clock or memory decides a lease. The vault is only
 * touched under that lock, so holding or dropping a run's keys can't interleave with
 * the claim that hands them out: keys are held before the transaction that makes a run
 * queued commits, and dropped by whatever ends or moves it. The lease token stays on an
 * ended run so the old holder's next heartbeat is told to `stop`; a recovery clears it,
 * so that holder is `lease-lost` (lease.ts).
 */
import { randomBytes } from "node:crypto";
import type { Run, VisitorKeys } from "@voluma/contracts/run";
import { LEASE_SECONDS, type Usage as RunnerUsage } from "@voluma/contracts/runner";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { and, asc, eq, notInArray, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Reader } from "../../domain";
import { admit, type Limits, type Refusal, refusalMessage, type Usage, usage } from "./admission";
import type { KeyVault } from "./key-vault";
import { LeaseLost } from "./lease";
import type { Notifier } from "./notifier";
import { loadRun, loadRuns, readableInputs, readableRuns, type Tx } from "./pg-runs";
import { inputs, runs } from "./schema";

/** Serializes every transaction that changes a run, so the limit counts can't race a claim. */
const QUEUE_LOCK = 0x76_6f_6c_71;

/** Lease expiries with no `released` before a run ends `failed` (so a run that crashes the runner doesn't loop). */
const MAX_RECOVERIES = 3;
/** How long a visitor run waits for its keys. */
const KEYS_WAIT = sql`interval '24 hours'`;

const leaseUntil = sql`now() + make_interval(secs => ${LEASE_SECONDS})`;

/** A report on a run that already ended: the first end wins. */
export class RunEnded extends Error {
  constructor() {
    super("run has ended");
  }
}

export type RunnerReport =
  | { kind: "ended"; outcome: "completed" | "failed"; error?: string }
  | { kind: "released" };

export type Claimed = {
  run: Run;
  leaseToken: string;
  /** The visitor run's keys, handed out once. */
  keys?: VisitorKeys;
};

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

const NO_LIMITS = "This organization can no longer run work.";

/**
 * `limits` has every org the API serves (index.ts). An org missing from it is one no
 * longer configured: its queued runs fail and its running ones stop.
 */
export function pgRunQueue(
  db: PostgresJsDatabase,
  limits: ReadonlyMap<string, Limits>,
  vault: KeyVault,
  notifier: Notifier,
) {
  const locked = <T>(work: (tx: Tx) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
      return work(tx);
    });

  /** Browser calls only: a signed-in user's or guest's org is always configured (auth.ts). */
  const limitsOf = (labId: string): Limits => {
    const found = limits.get(labId);
    if (!found) throw new Error(`organization ${labId} has no run limits`);
    return found;
  };

  return {
    /**
     * Creates the run `queued`. Refuses an input the reader can't read, a limit already
     * reached, and a visitor run when the vault is full.
     */
    async start(
      reader: Reader,
      caller: { userId: string },
      request: {
        id: string;
        workflowId: string;
        pins: WorkflowPin[];
        inputId: string;
        selectedOutputs?: string[];
        notes?: string;
        /** Present for a visitor run. */
        keys?: VisitorKeys;
      },
    ): Promise<{ run: Run } | { refused: Refusal | "no-input" | "full" }> {
      const credentials = request.keys ? "visitor" : "voluma";
      try {
        return await locked(async (tx) => {
          const [input] = await tx
            .select({ id: inputs.id })
            .from(inputs)
            .where(and(readableInputs(reader), eq(inputs.id, request.inputId)));
          if (!input) return { refused: "no-input" as const };
          const refused = admit(
            "start",
            limitsOf(reader.labId),
            await usage(tx, reader.labId, { userId: caller.userId, credentials }),
            { credentials },
          );
          if (refused) return { refused };
          if (request.keys && !vault.hold(request.id, reader.labId, request.keys)) {
            return { refused: "full" as const };
          }
          await tx.insert(runs).values({
            id: request.id,
            labId: reader.labId,
            startedBy: caller.userId,
            workflowId: request.workflowId,
            workflows: request.pins,
            selectedOutputs: request.selectedOutputs ?? null,
            notes: request.notes ?? null,
            inputId: request.inputId,
            credentials,
            state: "queued",
          });
          return { run: await loadRun(tx, request.id) };
        });
      } catch (error) {
        vault.drop(request.id);
        throw error;
      }
    },

    /** Ends the run `cancelled` at once and forgets its keys. Example runs are read-only. */
    async cancel(reader: Reader, runId: string) {
      const result = await locked(async (tx) => {
        const [run] = await loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)));
        if (!run) return "not-found" as const;
        if (run.example) return "example" as const;
        vault.drop(runId);
        if (run.state.status === "ended") return run;
        await tx
          .update(runs)
          .set({ state: "ended", outcome: "cancelled", endedAt: sql`now()` })
          .where(eq(runs.id, runId));
        return loadRun(tx, runId);
      });
      notifier.notify(runId);
      return result;
    },

    /**
     * `awaiting-keys` → `queued`, for the run's own starter, holding the new keys. The run
     * stays as it was when the visitor cap is reached or the vault is full.
     */
    async resume(reader: Reader, userId: string, runId: string, keys: VisitorKeys) {
      try {
        return await locked(async (tx) => {
          const [run] = await loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)));
          if (!run) return "not-found" as const;
          if (run.startedBy !== userId) return "forbidden" as const;
          if (run.state.status !== "awaiting-keys") return "conflict" as const;
          const refused = admit(
            "resume",
            limitsOf(reader.labId),
            await usage(tx, reader.labId),
            run,
          );
          if (refused) return refused;
          if (!vault.hold(runId, reader.labId, keys)) return "full" as const;
          await tx
            .update(runs)
            .set({ state: "queued", awaitingSince: null })
            .where(eq(runs.id, runId));
          return loadRun(tx, runId);
        });
      } catch (error) {
        vault.drop(runId);
        throw error;
      }
    },

    /**
     * One transaction: sweep expired leases, send the queued visitor runs whose keys this
     * process doesn't hold (another process took the start, or it restarted) to
     * `awaiting-keys`, then take the oldest queued run of the org served longest ago
     * that the limits allow, with its keys if it is a visitor run. The held ids are read
     * under the lock: a start that holds its keys before it commits is either in them or
     * not yet queued.
     */
    claim: (runnerId: string) =>
      locked(async (tx): Promise<Claimed | null> => {
        await sweep(tx);
        await tx
          .update(runs)
          .set({ state: "awaiting-keys", awaitingSince: sql`now()` })
          .where(
            and(
              eq(runs.state, "queued"),
              eq(runs.credentials, "visitor"),
              notInArray(runs.id, vault.ids()),
            ),
          );
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
        // Failing or skipping a run changes none of these counts, so read each org's once.
        const usages = new Map<string, Usage>();
        for (const run of queued) {
          const orgLimits = limits.get(run.labId);
          if (!orgLimits) {
            await fail(tx, run.id, NO_LIMITS);
            vault.drop(run.id);
            continue;
          }
          if (run.credentials === "voluma") {
            const used = usages.get(run.labId) ?? (await usage(tx, run.labId));
            usages.set(run.labId, used);
            const refused = admit("claim", orgLimits, used, {
              credentials: "voluma",
              firstClaim: run.startedAt === null,
            });
            if (refused === "concurrent") continue;
            if (refused) {
              await fail(tx, run.id, refusalMessage[refused]);
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
          const keys = run.credentials === "visitor" ? vault.take(run.id) : undefined;
          return {
            run: await loadRun(tx, run.id),
            leaseToken,
            ...(keys && { keys }),
          };
        }
        return null;
      }),

    /** Extends the lease and adds the usage; `stop` once the run has ended. Throws `LeaseLost`. */
    heartbeat: (runId: string, leaseToken: string, used: RunnerUsage) =>
      locked(async (tx) => {
        const [run] = await tx
          .select()
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.leaseToken, leaseToken)))
          .for("update");
        if (!run) throw new LeaseLost();
        if (run.state !== "running") return { stop: true };
        const orgLimits = limits.get(run.labId);
        if (!orgLimits) {
          await fail(tx, runId, NO_LIMITS);
          return { stop: true };
        }
        await tx
          .update(runs)
          .set({
            leaseExpiresAt: leaseUntil,
            modelCostUsd: sql`${runs.modelCostUsd} + ${used.modelCostUsd}`,
            sandboxSeconds: sql`${runs.sandboxSeconds} + ${used.sandboxSeconds}`,
          })
          .where(eq(runs.id, runId));
        if (run.credentials === "voluma") {
          const refused = admit("heartbeat", orgLimits, await usage(tx, run.labId), run);
          if (refused) {
            await fail(tx, runId, refusalMessage[refused]);
            return { stop: true };
          }
        }
        return { stop: false };
      }),

    /** Throws `LeaseLost` or `RunEnded`. */
    async report(runId: string, leaseToken: string, report: RunnerReport) {
      await locked(async (tx) => {
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
      });
      notifier.notify(runId);
    },
  };
}

export type RunQueue = ReturnType<typeof pgRunQueue>;
