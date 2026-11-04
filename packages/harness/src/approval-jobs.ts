/**
 * What the loop does with the researcher's answers to held calls (`gate.ts`): a yes starts the
 * stored call as a job, a no leaves the outputs it named to the researcher.
 *
 * A job runs outside the step's section: the tool takes the section itself, as it does inside a
 * turn, and the lock is not re-entrant. Only one runs at a time. A job cut off by a deploy is
 * found again by the next claim, and the tool answers from the log what it had done. Every job
 * ends in `approval.settled`: the tool's result, or a refusal carrying the error's text. Only a
 * sandbox that could not be created is tried again (a few times in one claim); then it is refused
 * too, so an approval is never left for every later claim to fail on.
 */
import {
  type AgentLog,
  type ApprovalRecord,
  approvalLeftId,
  approvalSettledId,
  givenApprovals,
} from "@voluma/contracts/agents";
import { outputsFold } from "@voluma/contracts/output-fold";
import type { Recorder } from "./recorder";
import { SandboxUnavailableError, type ToolResult } from "./tools/tool";

/** An approved call, to be run as it was stored. */
export type ApprovedCall = Pick<
  ApprovalRecord,
  "requestId" | "threadId" | "toolCallId" | "tool" | "args" | "fileHashes"
>;

/** Tries of one job in a claim when the sandbox cannot be created. */
const ATTEMPTS = 3;

export interface ApprovalJobs {
  /** Starts the next approved call that has no job running; true when one started. */
  start(d: AgentLog): boolean;
  /**
   * A declined call leaves the outputs it named that were undecided at the answer's position in
   * the log to the researcher, a label overlay as its map, once. True when one was left.
   */
  leave(d: AgentLog): Promise<boolean>;
  /** The failure of storing an outcome, for the step to throw. */
  failure(): unknown;
}

export function approvalJobs(o: {
  recorder: Recorder;
  approved(call: ApprovedCall): Promise<ToolResult>;
  /** Leaves `outputId` to the researcher (`tools/keep-output.ts`); false when there is nothing to leave. */
  leaveOutput(
    threadId: string,
    eventId: string,
    outputId: string,
    labels: readonly string[],
  ): Promise<boolean>;
  signal?: AbortSignal;
  nudge(): void;
}): ApprovalJobs {
  const running = new Set<string>();
  const attempts = new Map<string, number>();
  /** The outputs undecided where each request ended, by the map each label names: fixed by the log, so found once. */
  const endState = new Map<
    string,
    { labels: ReadonlyMap<string, string>; undecided: Set<string> }
  >();
  let failure: unknown;

  const settle = (a: ApprovalRecord, outcome: "done" | "refused", text: string) =>
    o.recorder.append(
      a.threadId,
      "approval.settled",
      { toolCallId: a.toolCallId, outcome, text },
      approvalSettledId(a.requestId),
    );

  async function run(a: ApprovalRecord) {
    try {
      const result = await o.approved(a);
      await settle(a, result.isError ? "refused" : "done", result.output);
    } catch (error) {
      if (o.signal?.aborted) return;
      const tried = (attempts.get(a.requestId) ?? 0) + 1;
      attempts.set(a.requestId, tried);
      // Left given and unsettled, the next step starts it again.
      if (error instanceof SandboxUnavailableError && tried < ATTEMPTS) return;
      try {
        await settle(a, "refused", error instanceof Error ? error.message : String(error));
      } catch (stored) {
        failure ??= stored;
      }
    } finally {
      running.delete(a.requestId);
      o.nudge();
    }
  }

  return {
    start(d) {
      const next = running.size === 0 ? givenApprovals(d.approvals)[0] : undefined;
      if (!next) return false;
      running.add(next.requestId);
      void run(next);
      return true;
    },
    async leave(d) {
      for (const a of d.approvals) {
        if (a.answer?.kind !== "declined") continue;
        let state = endState.get(a.requestId);
        if (!state) {
          const fold = outputsFold(o.recorder.events().slice(0, a.answer.at + 1));
          state = {
            labels: fold.labels,
            undecided: new Set(fold.outputs.filter((x) => x.undecided).map((x) => x.id)),
          };
          endState.set(a.requestId, state);
        }
        // The labels named, by the map each is part of.
        const byMap = new Map<string, string[]>();
        for (const id of a.outputs ?? []) {
          const map = state.labels.get(id) ?? id;
          byMap.set(map, [...(byMap.get(map) ?? []), ...(map === id ? [] : [id])]);
        }
        for (const [map, labels] of byMap) {
          const eventId = approvalLeftId(a.requestId, map);
          if (!state.undecided.has(map) || d.written.has(eventId)) continue;
          if (await o.leaveOutput(a.threadId, eventId, map, labels)) return true;
        }
      }
      return false;
    },
    failure: () => failure,
  };
}
