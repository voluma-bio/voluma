/**
 * The counts behind an org's limits (`run.ts`, Limits), for `voluma` runs only. A day is
 * the last 24 hours by the database's clock. A run counts toward the day once, from its
 * first claim (`started_at`), so a recovered run isn't refused for a limit it passed.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { countRuns, type Tx } from "./run-rows";
import { runs } from "./schema";

const voluma = (labId: string) => and(eq(runs.labId, labId), eq(runs.credentials, "voluma"));
const inLastDay = gt(runs.startedAt, sql`now() - interval '1 day'`);

export const runningCount = (tx: Tx, labId: string) =>
  countRuns(tx, and(voluma(labId), eq(runs.state, "running")));

export const startedToday = (tx: Tx, labId: string) => countRuns(tx, and(voluma(labId), inLastDay));

/** Queued runs that have never been claimed: they will count toward the day when they start. */
export const waitingCount = (tx: Tx, labId: string) =>
  countRuns(tx, and(voluma(labId), eq(runs.state, "queued"), isNull(runs.startedAt)));

export async function spentToday(tx: Tx, labId: string): Promise<number> {
  const [row] = await tx
    .select({ usd: sql<number>`coalesce(sum(${runs.modelCostUsd}), 0)::float8` })
    .from(runs)
    .where(and(voluma(labId), inLastDay));
  return row?.usd ?? 0;
}
