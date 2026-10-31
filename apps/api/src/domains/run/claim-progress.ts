/**
 * The no-progress limit: a run whose runner keeps vanishing (the server expires its lease: a
 * crash, an OOM), a runner that reports its event loop stalled (`loop-stalled`) or one whose
 * heartbeat the API refused (`refused`), without changing run state, ends `failed` instead of
 * looping. A `shutdown` or `self-stop` (the process was alive and no call reached the API) is
 * never counted. The runner reports `loop-stalled` only when it held that one run for the
 * blocked time; with two runs live a block is `self-stop` for both, so a run that blocks a
 * shared runner is not counted until it is the only one live. Progress is a change to run state
 * (a task, checkpoint, output, attempt, revision or plan change); model turns and tool calls are not, since a loop that kills the runner every
 * time still makes them. The run row keeps `last_progress_seq` (set on append) and the
 * current claim's `claim_start_seq`; `endClaim` judges a claim when it ends.
 */
import type { ReleaseReason } from "@voluma/contracts/runner";

/** Why a claim ends now; `provider-outage` is read only (`claimEndReasonSchema`). */
export type ClaimEnd = ReleaseReason | "lease-expired";

const COUNTED: ReadonlySet<ClaimEnd> = new Set(["lease-expired", "loop-stalled", "refused"]);

/** Whether a claim that ends for this reason without progress is a strike. */
export const isCounted = (reason: ClaimEnd) => COUNTED.has(reason);

const PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "task",
  "checkpoint",
  "output",
  "attempt.opened",
  "revision.started",
  "plan.changed",
  // Review-asset conversion is progress: a run whose only work left is conversion is not stalled.
  "assets.ready",
]);

/**
 * Whether an appended event is run-state progress. The plan every first claim writes
 * (`revision.started` with reason `run`) is not: a run that crashes its runner right after
 * planning has made none.
 */
export const isProgress = (event: { type: string; payload: unknown }) =>
  PROGRESS_EVENT_TYPES.has(event.type) &&
  !(event.type === "revision.started" && (event.payload as { reason?: string }).reason === "run");

/** Consecutive claims that end without progress before the run fails. */
export const STALLED_CLAIMS_LIMIT = 3;

export function endClaim(
  run: { lastProgressSeq: number; claimStartSeq: number; stalledClaims: number },
  reason: ClaimEnd,
): { stalledClaims: number; exhausted: boolean; counted: boolean } {
  const progressed = run.lastProgressSeq > run.claimStartSeq;
  const stalledClaims = progressed ? 0 : run.stalledClaims + (isCounted(reason) ? 1 : 0);
  return {
    stalledClaims,
    exhausted: stalledClaims >= STALLED_CLAIMS_LIMIT,
    counted: stalledClaims > run.stalledClaims,
  };
}

/** The run's error: a clause the researcher reads after "The run stopped: ". */
export const stalledError = (tool: string | undefined) =>
  `the server lost contact with the runner ${STALLED_CLAIMS_LIMIT} times in a row without progress${tool ? ` (last call: \`${tool}\`)` : ""}`;
