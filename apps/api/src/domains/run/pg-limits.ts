/**
 * The counts behind an org's limits (`run.ts`, Limits), by credentials kind. Examples are
 * seeded, not work, so no count includes them. A day is the last 24 hours by the
 * database's clock. A `voluma` run counts toward the day once, from its first claim
 * (`started_at`), so a recovered run isn't refused for a limit it passed.
 */
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { countRuns, type Tx } from "./run-rows";
import { runs } from "./schema";

const kind = (labId: string, credentials: "voluma" | "visitor") =>
  and(eq(runs.labId, labId), eq(runs.credentials, credentials), eq(runs.example, false));
const voluma = (labId: string) => kind(labId, "voluma");
const inLastDay = gt(runs.startedAt, sql`now() - interval '1 day'`);

export const runningCount = (tx: Tx, labId: string) =>
  countRuns(tx, and(voluma(labId), eq(runs.state, "running")));

/**
 * The org's visitor runs that are queued or running (`limits.visitorActive` caps these at
 * start and `/keys`, the only calls that add to it). An `awaiting-keys` run holds neither
 * keys nor a runner, so it isn't counted.
 */
export const visitorActiveCount = (tx: Tx, labId: string) =>
  countRuns(tx, and(kind(labId, "visitor"), inArray(runs.state, ["queued", "running"])));

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
