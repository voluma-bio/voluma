/**
 * What an org may do (`@voluma/contracts/run`, Limits) and the one check that enforces
 * it. `usage` reads every count from one query; `admit` judges a run at a stage with them.
 * Examples are seeded, not work, so no count includes them. A day is the last 24 hours by
 * the database's clock. A `voluma` run counts toward the day once, from its first claim
 * (`started_at`), so a recovered run isn't refused for a limit it passed.
 */
import type { Run } from "@voluma/contracts/run";
import { sql } from "drizzle-orm";
import type { Tx } from "./pg-runs";

/** An unset limit is `Infinity`, so every comparison below needs no unset case. */
export type Limits = {
  perCaller: number;
  concurrent: number;
  perDay: number;
  /** Visitor runs queued or running, per org: the cap at start and `/keys`. */
  visitorActive: number;
};

export type Refusal = "concurrent" | "per-caller" | "visitor-active" | "daily";

/** One message per refusal: the API's answer and a failed run's stored error (a `concurrent` claim just leaves the run queued). */
export const refusalMessage: Record<Refusal, string> = {
  concurrent: "The organization's runs-at-once limit was reached.",
  "per-caller": "You already have a run in progress.",
  "visitor-active": "Too many runs with your own keys are active.",
  daily: "The organization's daily run limit was reached.",
};

export type Usage = {
  /** `voluma` runs running now. */
  running: number;
  /** `voluma` runs first claimed in the last day. */
  startedToday: number;
  /** `voluma` runs queued and never claimed: they count toward the day when they start. */
  waiting: number;
  /** Visitor runs queued or running. An `awaiting-keys` run holds neither keys nor a runner. */
  visitorActive: number;
  /** The caller's unfinished runs of the credentials kind being started (0 when no caller). */
  callerUnfinished: number;
};

export async function usage(
  tx: Tx,
  labId: string,
  caller?: { userId: string; credentials: Run["credentials"] },
): Promise<Usage> {
  const today = sql`credentials = 'voluma' AND started_at > now() - interval '1 day'`;
  const [row] = await tx.execute<Usage>(sql`
    SELECT
      (count(*) FILTER (WHERE credentials = 'voluma' AND state = 'running'))::int AS "running",
      (count(*) FILTER (WHERE ${today}))::int AS "startedToday",
      (count(*) FILTER (WHERE credentials = 'voluma' AND state = 'queued' AND started_at IS NULL))::int AS "waiting",
      (count(*) FILTER (WHERE credentials = 'visitor' AND state IN ('queued', 'running')))::int AS "visitorActive",
      (count(*) FILTER (WHERE ${caller ? sql`started_by = ${caller.userId} AND credentials = ${caller.credentials} AND state <> 'ended'` : sql`false`}))::int AS "callerUnfinished"
    FROM runs WHERE lab_id = ${labId} AND NOT example`);
  return row as Usage;
}

/**
 * Why `run` may not go on at `stage`, or null. Start and resume admit either kind of run;
 * claim is for `voluma` runs, since a visitor run's cap was checked when it
 * was queued. A reopen (a correction) is judged as a start without the daily run count: it is
 * no new run. Checks run in this order.
 */
export function admit(
  stage: "start" | "resume" | "reopen" | "claim",
  limits: Limits,
  u: Usage,
  run: { credentials: Run["credentials"]; firstClaim?: boolean },
): Refusal | null {
  if (stage === "claim" && u.running >= limits.concurrent) return "concurrent";
  if ((stage === "start" || stage === "reopen") && u.callerUnfinished >= limits.perCaller)
    return "per-caller";
  if (run.credentials === "visitor") {
    return u.visitorActive >= limits.visitorActive ? "visitor-active" : null;
  }
  if (stage === "start" && u.startedToday + u.waiting >= limits.perDay) return "daily";
  if (stage === "claim" && run.firstClaim && u.startedToday >= limits.perDay) return "daily";
  return null;
}
