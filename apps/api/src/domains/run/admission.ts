/**
 * What an org may do (`@voluma/contracts/run`, Limits) and the one check that enforces
 * it. `usage` reads every count from one query; `admit` judges a run at a stage with them.
 * Examples are seeded, not work, so no count includes them.
 */
import type { Run } from "@voluma/contracts/run";
import { sql } from "drizzle-orm";
import type { Tx } from "./pg-runs";

/** An unset limit is `Infinity`, so every comparison below needs no unset case. */
export type KeyLimits = {
  /** `voluma` runs of the org running at once. */
  concurrent: number;
  /** Dollars of model spend the org's runs on Voluma's keys may total (`Usage.spentUsd`). */
  spendUsd: number;
};

/**
 * What guards Voluma's key: `voluma` has an entry for each pre-created organization that may
 * run on it (index.ts), each counted on its own; `ownKeyActive` caps the runs on callers' own keys
 * (queued or running, over every account), since the server holds their keys in memory.
 */
export type Limits = {
  voluma: ReadonlyMap<string, KeyLimits>;
  ownKeyActive: number;
};

export type Refusal = "concurrent" | "no-key" | "own-key-active" | "spend";

/** One message per refusal: the API's answer when a start, resume or reopen is refused. */
export const refusalMessage: Record<Refusal, string> = {
  concurrent: "The organization's runs-at-once limit was reached.",
  "no-key": "This account has no access to Voluma's keys. Add your own keys.",
  "own-key-active": "Too many runs with your own keys are active.",
  spend: "This organization has used its model budget for runs.",
};

/**
 * The same refusal as a run's stored error when a claim fails the run (a `concurrent` claim just
 * leaves it queued): a clause read after "The run stopped: ", as every run error is.
 */
export const refusalError: Record<Refusal, string> = {
  concurrent: "the organization's runs-at-once limit was reached",
  "no-key": "this account can no longer use Voluma's keys",
  "own-key-active": "too many runs with your own keys were active",
  spend: "the organization had used its model budget for runs",
};

export type Usage = {
  /** The org's `voluma` runs running now. */
  running: number;
  /** Own-key runs queued or running, over every org; 0 unless the usage was read for an own-key run. An `awaiting-keys` run holds neither keys nor a runner. */
  ownKeyActive: number;
  /** Model dollars spent by the org's runs on Voluma's keys, every run ever (the heartbeat adds to `runs.model_cost_usd`). */
  spentUsd: number;
};

export async function usage(
  tx: Tx,
  labId: string,
  credentials: Run["credentials"],
): Promise<Usage> {
  const [row] = await tx.execute<Pick<Usage, "running" | "spentUsd">>(sql`
    SELECT
      (count(*) FILTER (WHERE credentials = 'voluma' AND state = 'running'))::int AS "running",
      (coalesce(sum(model_cost_usd) FILTER (WHERE credentials = 'voluma'), 0))::float8 AS "spentUsd"
    FROM runs WHERE lab_id = ${labId} AND NOT example`);
  if (credentials === "voluma") return { ...row, ownKeyActive: 0 } as Usage;
  const [own] = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM runs
    WHERE credentials = 'visitor' AND state IN ('queued', 'running') AND NOT example`);
  return { ...row, ownKeyActive: own?.n ?? 0 } as Usage;
}

/**
 * Why `run` may not go on at `stage`, or null. Start and resume admit either kind of run;
 * claim is for `voluma` runs, since an own-key run's cap was checked when it was queued. A reopen
 * (a correction) of a `voluma` run (the route refuses own-key runs first) is judged by the spend
 * limit. A claim refuses on spend only a run that never started (one start request can queue
 * many runs under the limit); a run that started keeps going after a deploy or a reopen, so a
 * live run is never refused.
 */
export function admit(
  stage: "start" | "resume" | "reopen" | "claim",
  limits: Limits,
  labId: string,
  u: Usage,
  run: { credentials: Run["credentials"]; started?: boolean },
): Refusal | null {
  if (run.credentials === "visitor") {
    return stage !== "reopen" && u.ownKeyActive >= limits.ownKeyActive ? "own-key-active" : null;
  }
  const org = limits.voluma.get(labId);
  if (!org) return "no-key";
  if (stage === "claim" && u.running >= org.concurrent) return "concurrent";
  if (!(stage === "claim" && run.started) && u.spentUsd >= org.spendUsd) return "spend";
  return null;
}
