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
 * What guards Voluma's key and the runner slots (index.ts). `voluma` has an entry for each
 * pre-created organization that may run on it, each counted on its own; its order is the queue
 * priority (first is served first). The three `*Running` numbers cap runs `running` over every
 * account and organization, enforced by the claim: all runs, runs on callers' own keys, and runs
 * on Voluma's keys. A run over a cap waits `queued`; nothing is refused for it.
 */
export type Limits = {
  voluma: ReadonlyMap<string, KeyLimits>;
  appRunning: number;
  ownKeyRunning: number;
  volumaRunning: number;
};

export type Refusal = "concurrent" | "no-key" | "spend";

/** One message per refusal: the API's answer when a start, resume or reopen is refused. */
export const refusalMessage: Record<Refusal, string> = {
  concurrent: "The organization's runs-at-once limit was reached.",
  "no-key": "This account has no access to Voluma's keys. Add your own keys.",
  spend: "This organization has used its model budget for runs.",
};

/**
 * The same refusal as a run's stored error when a claim fails the run (a `concurrent` claim just
 * leaves it queued): a clause read after "The run stopped: ", as every run error is.
 */
export const refusalError: Record<Refusal, string> = {
  concurrent: "the organization's runs-at-once limit was reached",
  "no-key": "this account can no longer use Voluma's keys",
  spend: "the organization had used its model budget for runs",
};

export type Usage = {
  /** The org's `voluma` runs running now. */
  running: number;
  /** Model dollars spent by the org's runs on Voluma's keys, every run ever (the heartbeat adds to `runs.model_cost_usd`). */
  spentUsd: number;
};

export async function usage(tx: Tx, labId: string): Promise<Usage> {
  const [row] = await tx.execute<Usage>(sql`
    SELECT
      (count(*) FILTER (WHERE credentials = 'voluma' AND state = 'running'))::int AS "running",
      (coalesce(sum(model_cost_usd) FILTER (WHERE credentials = 'voluma'), 0))::float8 AS "spentUsd"
    FROM runs WHERE lab_id = ${labId} AND NOT example`);
  return row as Usage;
}

/**
 * Why `run` may not go on at `stage`, or null. An own-key run is never refused (it costs
 * Voluma only runner time, which the claim's slot caps queue). A reopen
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
  if (run.credentials === "visitor") return null;
  const org = limits.voluma.get(labId);
  if (!org) return "no-key";
  if (stage === "claim" && u.running >= org.concurrent) return "concurrent";
  if (!(stage === "claim" && run.started) && u.spentUsd >= org.spendUsd) return "spend";
  return null;
}
