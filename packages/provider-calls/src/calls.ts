/**
 * The gateway's database side, which the API shares: admit a call (one transaction under the
 * run's row lock), settle it, close rows left open, and sum a run's calls. The `runs` columns it
 * reads are named in SQL (`state`, `lease_token`, `lease_expires_at`, `model_cost_usd`,
 * `cost_cap_usd`), so nothing here imports the API.
 *
 * A call's cost for the cap is its `cost_usd`, else its reservation: an `open` call or one `cut`
 * with no usage seen may still be billed. A run's reported spend leaves `open` calls out (they
 * are in flight, not spent).
 */
import { and, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Observed } from "./prices";
import { providerCalls } from "./schema";

export type Db = Pick<PostgresJsDatabase, "execute" | "select">;

/** Calls in flight per sandbox token. */
export const MAX_IN_FLIGHT = 4;
/** The longest a call may run (the gateway's upstream timeouts), plus a margin for clock drift. */
export const STALE_OPEN_MINUTES = 40;

const heldUsd = sql`coalesce(${providerCalls.costUsd}, ${providerCalls.reservedUsd})`;

export type NewCall = {
  id: string;
  runId: string;
  leaseHash: string;
  sandbox: string;
  provider: string;
  route: string;
  model: string | null;
  instance: string;
  reservedUsd: number;
};

export type Refusal = { status: 401 | 402 | 429; reason: string };

type RunRow = {
  state: string;
  lease_ok: boolean;
  lease_live: boolean;
  spent_usd: number;
  cost_cap_usd: number;
};

/**
 * Locks the run's row (`FOR UPDATE`: a lock per run, not the API's queue lock), checks that the
 * token may still spend, and inserts the `open` row with its reservation in the same transaction,
 * so concurrent calls cannot all pass one check. Returns the refusal, or null once the row exists.
 */
export function admitCall(db: PostgresJsDatabase, call: NewCall): Promise<Refusal | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx.execute<RunRow>(sql`
      SELECT state,
        coalesce(encode(sha256(convert_to(lease_token, 'UTF8')), 'hex') = ${call.leaseHash}, false) AS lease_ok,
        coalesce(lease_expires_at > now(), false) AS lease_live,
        cost_cap_usd::float8 AS cost_cap_usd,
        (model_cost_usd + (
          SELECT coalesce(sum(coalesce(cost_usd, reserved_usd)), 0)
          FROM provider_calls WHERE run_id = runs.id
        ))::float8 AS spent_usd
      FROM runs WHERE id = ${call.runId} FOR UPDATE`);
    if (!run) return { status: 401, reason: "unknown run" };
    if (run.state !== "running") return { status: 401, reason: "the run is not running" };
    if (!run.lease_ok) return { status: 401, reason: "the run was claimed again" };
    if (!run.lease_live) return { status: 401, reason: "the run's lease expired" };
    const [open] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(providerCalls)
      .where(
        and(
          eq(providerCalls.runId, call.runId),
          eq(providerCalls.sandbox, call.sandbox),
          eq(providerCalls.status, "open"),
        ),
      );
    if ((open?.n ?? 0) >= MAX_IN_FLIGHT) {
      return { status: 429, reason: `${MAX_IN_FLIGHT} calls are already in flight` };
    }
    if (!fits(run.spent_usd, call.reservedUsd, run.cost_cap_usd)) {
      return {
        status: 402,
        reason: `the run's spend cap of $${run.cost_cap_usd} would be exceeded`,
      };
    }
    await tx.insert(providerCalls).values({
      id: call.id,
      runId: call.runId,
      sandbox: call.sandbox,
      provider: call.provider,
      route: call.route,
      model: call.model,
      instance: call.instance,
      status: "open",
      reservedUsd: call.reservedUsd,
    });
    return null;
  });
}

/** Whether spend plus a reservation stays within the cap (to the cent's millionth, for floats). */
export const fits = (spentUsd: number, reservedUsd: number, capUsd: number) =>
  spentUsd + reservedUsd <= capUsd + 1e-9;

export type Settled = Observed & {
  status: "done" | "failed" | "cut";
  costUsd: number | null;
  httpStatus?: number;
  fileId?: string;
  ttfbMs?: number;
  durationMs: number;
};

/** Ends a call. Unconditional: whatever the row's status by then, the actual cost replaces the reservation. */
export async function settleCall(db: PostgresJsDatabase, id: string, end: Settled) {
  await db
    .update(providerCalls)
    .set({
      status: end.status,
      costUsd: end.costUsd,
      httpStatus: end.httpStatus ?? null,
      fileId: end.fileId ?? null,
      frames: end.frames ?? null,
      inputTokens: end.inputTokens ?? null,
      outputTokens: end.outputTokens ?? null,
      ttfbMs: end.ttfbMs ?? null,
      durationMs: end.durationMs,
    })
    .where(eq(providerCalls.id, id));
}

/** At shutdown, after draining: an instance's own `open` rows become `cut` and keep their reservation. */
export async function cutOwnCalls(db: PostgresJsDatabase, instance: string) {
  const cut = await db
    .update(providerCalls)
    .set({ status: "cut" })
    .where(and(eq(providerCalls.instance, instance), eq(providerCalls.status, "open")))
    .returning({ id: providerCalls.id });
  return cut.length;
}

/**
 * At boot: only rows older than the longest call. An older instance still draining after a
 * redeploy is streaming newer rows, which are not ours to close.
 */
export async function cutStaleCalls(db: PostgresJsDatabase) {
  const cut = await db
    .update(providerCalls)
    .set({ status: "cut" })
    .where(
      and(
        eq(providerCalls.status, "open"),
        sql`${providerCalls.startedAt} < now() - make_interval(mins => ${STALE_OPEN_MINUTES})`,
      ),
    )
    .returning({ id: providerCalls.id });
  return cut.length;
}

export type RunCalls = {
  costUsd: number;
  calls: number;
  bySandbox: { sandbox: string; costUsd: number; calls: number }[];
};

/** Each run's calls that are no longer in flight, by sandbox; a run with none is absent. */
export async function callsOfRuns(db: Db, runIds: string[]): Promise<Map<string, RunCalls>> {
  const out = new Map<string, RunCalls>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select({
      runId: providerCalls.runId,
      sandbox: providerCalls.sandbox,
      calls: sql<number>`count(*)::int`,
      costUsd: sql<number>`coalesce(sum(${heldUsd}), 0)::float8`,
    })
    .from(providerCalls)
    .where(and(inArray(providerCalls.runId, runIds), ne(providerCalls.status, "open")))
    .groupBy(providerCalls.runId, providerCalls.sandbox)
    .orderBy(providerCalls.runId, providerCalls.sandbox);
  for (const { runId, ...bySandbox } of rows) {
    const run = out.get(runId) ?? { costUsd: 0, calls: 0, bySandbox: [] };
    run.costUsd += bySandbox.costUsd;
    run.calls += bySandbox.calls;
    run.bySandbox.push(bySandbox);
    out.set(runId, run);
  }
  return out;
}

/** SQL for one run's settled provider spend, to add to a query over `runs` (the org's daily total). */
export const settledUsdOf = (runId: SQL): SQL =>
  sql`(SELECT coalesce(sum(coalesce(cost_usd, reserved_usd)), 0) FROM provider_calls WHERE run_id = ${runId} AND status <> 'open')`;
