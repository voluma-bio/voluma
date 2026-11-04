/**
 * The words the agent loop sends an agent that are not built from the log: what a cut-off thread
 * is told on resume, the nudge to an idle main, and what the researcher reads when a run fails
 * to start. The loop holds the rules and no prose.
 */
import type { ClaimEndReason } from "@voluma/contracts/runner";

const PLAIN_REASON: Record<ClaimEndReason, string> = {
  shutdown: "the runner restarted",
  "self-stop": "the runner lost contact with the server",
  "loop-stalled": "the runner was too busy to answer the server",
  refused: "the server refused the runner's heartbeat",
  "lease-expired": "the server lost contact with the runner",
};

/** What a cut-off thread is told on resume: the tool it was in, if any, and why, in plain words. */
export function cutOffText(after: ClaimEndReason | undefined, tool: string | undefined): string {
  const when = after ? `when ${PLAIN_REASON[after]}` : "when the run was restarted";
  return tool
    ? `Your last call (\`${tool}\`) was cut off ${when}. It may or may not have finished: check its output, then continue.`
    : `You were cut off ${when}; continue.`;
}

/** What the main agent is told when the provider failed after its reply started; its history is as it was. */
export const PROVIDER_FAILED_RESUME = "The model provider failed during your last reply; continue.";

/** The nudge to an idle main: its tools are messages, workers and `close`. */
export const agentLivenessNudge = (state: string) =>
  `Nothing is running and the run is not finished: answer a worker, start one, or close the run.\n\n${state}`;
