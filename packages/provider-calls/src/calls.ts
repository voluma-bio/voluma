/**
 * The gateway's database side, which the API shares: admit a call (one transaction under the
 * run's row lock), settle it, close rows left open, and sum a run's calls. The `runs` columns it
 * reads are named in SQL (`state`, `lease_token`, `lease_expires_at`, `credentials`), so
 * nothing here imports the API.
 *
 * No spend limit is checked at admission. A call's cost is its `cost_usd`; a call that ended with none
 * (`cut`) has an unknown cost, counted apart and never as an amount. Spend is the sum of known
 * costs, so an `open` call counts nothing until it settles.
 */
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Observed } from "./prices";
import { providerCalls } from "./schema";

export type Db = Pick<PostgresJsDatabase, "execute" | "select">;

/** Calls in flight per sandbox token. */
export const MAX_IN_FLIGHT = 4;
/** The longest a call may run: the gateway aborts it at this age. */
export const MAX_CALL_MS = 30 * 60_000;
/** An `open` row older than this belongs to no live call: the longest call plus a margin for clock drift. */
export const STALE_OPEN_MINUTES = MAX_CALL_MS / 60_000 + 10;

export type NewCall = {
  id: string;
  runId: string;
  leaseHash: string;
  sandbox: string;
  provider: string;
  route: string;
  model: string | null;
  instance: string;
  /** Whether the token carries a visitor's own keys; the run's `credentials` must agree. */
  visitor: boolean;
};

export type Refusal = { status: 401 | 403 | 429; reason: string };

type RunRow = {
  state: string;
  credentials: string;
  lease_ok: boolean;
  lease_live: boolean;
};

/**
 * Locks the run's row (`FOR UPDATE`: a lock per run, not the API's queue lock), checks that the
 * token may still spend, and inserts the `open` row in the same transaction, so concurrent
 * calls cannot all pass one check. Returns the refusal, or null once the row exists.
 */
export function admitCall(db: PostgresJsDatabase, call: NewCall): Promise<Refusal | null> {
  return db.transaction(async (tx) => {
    // The lock is its own statement: a statement that waited for the lock still reads other
    // tables as of its start, so it would miss rows the call ahead of it just inserted. The
    // statements below start after the lock is held.
    const [run] = await tx.execute<RunRow>(sql`
      SELECT state, credentials,
        coalesce(encode(sha256(convert_to(lease_token, 'UTF8')), 'hex') = ${call.leaseHash}, false) AS lease_ok,
        coalesce(lease_expires_at > now(), false) AS lease_live
      FROM runs WHERE id = ${call.runId} FOR UPDATE`);
    if (!run) return { status: 401, reason: "unknown run" };
    if (run.state !== "running") return { status: 401, reason: "the run is not running" };
    if (!run.lease_ok) return { status: 401, reason: "the run was claimed again" };
    if (!run.lease_live) return { status: 401, reason: "the run's lease expired" };
    // The database decides whose keys a run spends; a token minted the other way is a lane-2 bug.
    if ((run.credentials === "visitor") !== call.visitor) {
      return { status: 403, reason: "the token's keys do not match the run's credentials" };
    }
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
    await tx.insert(providerCalls).values({
      id: call.id,
      runId: call.runId,
      sandbox: call.sandbox,
      provider: call.provider,
      route: call.route,
      model: call.model,
      instance: call.instance,
      status: "open",
    });
    return null;
  });
}

export type Settled = Observed & {
  status: "done" | "failed" | "cut";
  costUsd: number | null;
  httpStatus?: number;
  fileId?: string;
  ttfbMs?: number;
  durationMs: number;
};

/**
 * Settles once, even after a sweep marked the call cut. Only settlement writes durationMs:
 * a non-null duration means accounting is final, so retries cannot change archived rows.
 */
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
    .where(and(eq(providerCalls.id, id), isNull(providerCalls.durationMs)));
}

/** At shutdown, after draining: an instance's own `open` rows become `cut` (cost unknown). */
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
  /** Known costs only. */
  costUsd: number;
  calls: number;
  /** Ended calls whose cost is unknown (`cut`). */
  unknownCostCalls: number;
  bySandbox: { sandbox: string; costUsd: number; calls: number; unknownCostCalls: number }[];
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
      costUsd: sql<number>`coalesce(sum(${providerCalls.costUsd}), 0)::float8`,
      unknownCostCalls: sql<number>`(count(*) FILTER (WHERE ${providerCalls.costUsd} IS NULL))::int`,
    })
    .from(providerCalls)
    .where(and(inArray(providerCalls.runId, runIds), ne(providerCalls.status, "open")))
    .groupBy(providerCalls.runId, providerCalls.sandbox)
    .orderBy(providerCalls.runId, providerCalls.sandbox);
  for (const { runId, ...bySandbox } of rows) {
    const run = out.get(runId) ?? { costUsd: 0, calls: 0, unknownCostCalls: 0, bySandbox: [] };
    run.costUsd += bySandbox.costUsd;
    run.calls += bySandbox.calls;
    run.unknownCostCalls += bySandbox.unknownCostCalls;
    run.bySandbox.push(bySandbox);
    out.set(runId, run);
  }
  return out;
}
