/**
 * The no-progress limit: a run whose claims keep ending in infrastructure trouble without
 * changing run state ends `failed` instead of looping. Progress is a change to run state
 * (a task, checkpoint, output, attempt or revision, or a judgment while the supervisor still
 * writes those); model turns and tool calls are not, since a loop that kills the runner every
 * time still makes them. The run row keeps `last_progress_seq` (set on append) and the
 * current claim's `claim_start_seq`; `endClaim` judges a claim when it ends.
 */
import type { ClaimEndReason } from "@voluma/contracts/runner";

const PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "task",
  "checkpoint",
  "output",
  "attempt.opened",
  "revision.started",
  "plan.changed",
  "judgment",
  // Phase 1's review-asset conversion, after the supervisor: a run whose only work left is
  // conversion is not stalled. Matched by type string; the event joins the contract with phase 1.
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

/** A deploy (`shutdown`) is nobody's fault: never counted. */
const COUNTED_REASONS: ReadonlySet<ClaimEndReason> = new Set(["self-stop", "lease-expired"]);

export function endClaim(
  run: { lastProgressSeq: number; claimStartSeq: number; stalledClaims: number },
  reason: ClaimEndReason,
): { stalledClaims: number; exhausted: boolean } {
  const progressed = run.lastProgressSeq > run.claimStartSeq;
  const stalledClaims = progressed ? 0 : run.stalledClaims + (COUNTED_REASONS.has(reason) ? 1 : 0);
  return { stalledClaims, exhausted: stalledClaims >= STALLED_CLAIMS_LIMIT };
}

const WHY: Record<ClaimEndReason, string> = {
  shutdown: "the runner restarted",
  "self-stop": "the runner lost contact with the server",
  "lease-expired": "the server lost contact with the runner",
};

export const stalledError = (reason: ClaimEndReason, tool: string | undefined) =>
  `Stopped: ${WHY[reason]} ${STALLED_CLAIMS_LIMIT} times in a row without progress${tool ? ` (last call: \`${tool}\`)` : ""}.`;
