/**
 * What an org may do (`@voluma/contracts/run`, Limits) and the one check that enforces
 * it. `spentUsd` reads the org's spend; `admit` judges a run at a stage with it.
 * Examples are seeded, not work, so no spend includes them.
 */
import type { OwnKeys, Run } from "@voluma/contracts/run";
import { sql } from "drizzle-orm";
import type { Tx } from "./pg-runs";

/**
 * What guards Voluma's key and the runner slots (index.ts). `voluma` has an entry for each
 * pre-created organization that may run on it, each counted on its own: the dollars of model spend
 * its runs on Voluma's keys may total (`spentUsd`; unset is `Infinity`). Its order is the queue
 * priority (first is served first). `appRunning` caps runs `running` over every account and
 * organization, enforced by the claim, of which at most one is on a caller's own keys. A run over
 * a cap waits `queued`; nothing is refused for it.
 */
export type Limits = {
  voluma: ReadonlyMap<string, number>;
  appRunning: number;
};

export type Refusal = "no-key" | "spend";

/** One message per refusal: the API's answer when a start or reopen is refused. */
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

/** Whether the org is configured to run on Voluma's keys: the one place that reads the org map for it. */
export const mayUseVolumaKey = (limits: Limits, labId: string) => limits.voluma.has(labId);

/** The 403 for a guest's own keys without a Modal token (`needsModal`). */
export const noModalMessage =
  "Add your Modal token in Settings to run on your own sandbox account.";

/**
 * True when `keys` start or reopen a run that would put its sandboxes on Voluma's Modal account for
 * an org that may not use Voluma's keys (a guest): a guest must bring a Modal token. Members may.
 */
export const needsModal = (limits: Limits, labId: string, keys: OwnKeys | undefined) =>
  keys !== undefined && !keys.modal && !mayUseVolumaKey(limits, labId);

/**
 * Why `run` may not go on, or null. An own-key run is never refused (it costs Voluma only runner
 * time, which the claim's slot caps queue). A start or a reopen (a correction) of a `voluma` run is
 * judged by the spend limit. A claim passes `started` for a run that already started: it keeps
 * going after a deploy or a reopen, so a live run is never refused on spend, while a claim of a
 * run that never started is (one start request can queue many runs under the limit).
 */
export function admit(
  limits: Limits,
  labId: string,
  spent: number,
  run: { credentials: Run["credentials"]; started?: boolean },
): Refusal | null {
  if (run.credentials !== "voluma") return null;
  if (!mayUseVolumaKey(limits, labId)) return "no-key";
  if (!run.started && spent >= (limits.voluma.get(labId) ?? 0)) return "spend";
  return null;
}
