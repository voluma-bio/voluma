/**
 * What an org may do (`@voluma/contracts/run`, Limits) and the one check that enforces
 * it. `spentUsd` reads the org's spend; `admit` judges a run at a stage with it.
 * Examples are seeded, not work, so no spend includes them.
 */
import type { Run } from "@voluma/contracts/run";
import { sql } from "drizzle-orm";
import type { Tx } from "./pg-runs";

/** An unset limit is `Infinity`, so every comparison below needs no unset case. */
export type KeyLimits = {
  /** Dollars of model spend the org's runs on Voluma's keys may total (`spentUsd`). */
  spendUsd: number;
};

/**
 * What guards Voluma's key and the runner slots (index.ts). `voluma` has an entry for each
 * pre-created organization that may run on it, each counted on its own; its order is the queue
 * priority (first is served first). `appRunning` caps runs `running` over every account and
 * organization, enforced by the claim, of which at most one is on a caller's own keys. A run over
 * a cap waits `queued`; nothing is refused for it.
 */
export type Limits = {
  voluma: ReadonlyMap<string, KeyLimits>;
  appRunning: number;
};

export type Refusal = "no-key" | "spend";

/** One message per refusal: the API's answer when a start, resume or reopen is refused. */
export const refusalMessage: Record<Refusal, string> = {
  "no-key": "This account has no access to Voluma's keys. Add your own keys.",
  spend: "This organization has used its model budget for runs.",
};

/**
 * The same refusal as a run's stored error when a claim fails the run: a clause read after "The run stopped: ", as every run error is.
 */
export const refusalError: Record<Refusal, string> = {
  "no-key": "this account can no longer use Voluma's keys",
  spend: "the organization had used its model budget for runs",
};

/** Model dollars spent by the org's runs on Voluma's keys, every run ever (the heartbeat adds to `runs.model_cost_usd`). */
export async function spentUsd(tx: Tx, labId: string): Promise<number> {
  const [row] = await tx.execute<{ spent: number }>(sql`
    SELECT (coalesce(sum(model_cost_usd), 0))::float8 AS spent
    FROM runs WHERE lab_id = ${labId} AND credentials = 'voluma' AND NOT example`);
  return row?.spent ?? 0;
}

/** Whether the org is configured to run on Voluma's keys; `admit` refuses `no-key` by the same map, and the heartbeat and `Me.volumaKey` ask this. */
export const mayUseVolumaKey = (limits: Limits, labId: string) => limits.voluma.has(labId);

/**
 * Why `run` may not go on at `stage`, or null. An own-key run is never refused (it costs
 * Voluma only runner time, which the claim's slot caps queue). A reopen
 * (a correction) of a `voluma` run (a reopen of an own-key run carries its own keys) is judged by the spend
 * limit. A claim refuses on spend only a run that never started (one start request can queue
 * many runs under the limit); a run that started keeps going after a deploy or a reopen, so a
 * live run is never refused.
 */
export function admit(
  stage: "start" | "reopen" | "claim",
  limits: Limits,
  labId: string,
  spent: number,
  run: { credentials: Run["credentials"]; started?: boolean },
): Refusal | null {
  if (run.credentials === "visitor") return null;
  const org = limits.voluma.get(labId);
  if (!org) return "no-key";
  if (!(stage === "claim" && run.started) && spent >= org.spendUsd) return "spend";
  return null;
}
