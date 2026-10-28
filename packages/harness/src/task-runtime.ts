/**
 * The runtime behind the task tools and the supervisor: every write of a `task`,
 * `checkpoint`, `output`, `attempt.opened` or `revision.started` event, under the rules in
 * `@voluma/contracts/task-tools`. Its only view of the run is `fold` of the recorder's
 * events, refolded for each decision; it keeps no second record. Each decision and its
 * appends run inside one per-run critical section (`section`), whichever thread asks, and
 * an append is acknowledged (stored) before the call returns. A refusal is thrown as a
 * `Refusal`: the tool turns it into the error the model reads, and nothing is appended.
 */

import type { By, EventType } from "@voluma/contracts/events";
import { checkResult, type Folded, type FoldedTask, fold } from "@voluma/contracts/fold";
import type { EvidenceRef } from "@voluma/contracts/output";
import type {
  ChecklistInput,
  CheckpointInput,
  ReportOutputInput,
  TaskToolResult,
} from "@voluma/contracts/task-tools";
import type { DeclaredOutput } from "@voluma/contracts/workflow";
import { transitiveDependents } from "@voluma/workflow";
import { declarationProblem, referenceProblem } from "./output-checks";
import type { Evidence } from "./ports/evidence";
import type { PayloadOf, Recorder } from "./recorder";

/** A plan task: its declared outputs and the tasks it builds on. */
export interface PlanTask {
  id: string;
  dependsOn: readonly string[];
  outputs: DeclaredOutput[];
}

/** The calling tool call. */
export interface Caller {
  threadId: string;
  toolCallId: string;
}

/** The call broke a rule; the message is what the model reads. */
export class Refusal extends Error {}

export interface TaskRuntimeOptions {
  recorder: Recorder;
  evidence: Evidence;
  runId: string;
  /** The thread under which the run's first event is written. */
  rootThreadId: string;
  plan: readonly PlanTask[];
  /** Called for a check thread whose task a stale mark has just taken from review. */
  stopThread(threadId: string): void;
}

const AGENT: By = { kind: "agent" };
const rule = (r: Extract<By, { kind: "rule" }>["rule"]): By => ({ kind: "rule", rule: r });

export function taskRuntime(options: TaskRuntimeOptions) {
  const { recorder, evidence, runId, rootThreadId, plan, stopThread } = options;
  const planned = new Map(plan.map((t) => [t.id, t]));

  let tail: Promise<unknown> = Promise.resolve();
  /** The per-run critical section: decisions run one at a time, each seeing every earlier write. */
  const section = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };

  const view = (): Folded => fold(recorder.events());
  const taskOf = (id: string): FoldedTask | undefined => view().tasks.find((t) => t.id === id);
  const kindOf = (threadId: string) => {
    const events = recorder.events();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.type === "thread.started" && e.threadId === threadId) return e.payload.kind;
    }
    return undefined;
  };

  async function append<T extends EventType>(
    threadId: string,
    type: T,
    payload: PayloadOf<T>,
    id: string,
  ): Promise<void> {
    if (!(await recorder.emit(threadId, type, payload, id))) {
      throw new Error(`the ${type} event ${id} could not be stored`);
    }
  }

  const known = (taskId: string) => {
    const t = planned.get(taskId);
    if (!t) throw new Refusal(`${taskId} is not a task of this run's plan`);
    return t;
  };

  async function openAttempt(c: Caller, taskId: string): Promise<string> {
    const id = `${c.threadId}:${c.toolCallId}:open`;
    await append(c.threadId, "attempt.opened", { taskId }, id);
    return id;
  }

  /**
   * The attempt a worker's write joins. Returns a function that opens one when the task
   * has none (or is `stale` or `failed` and `redo`), so a refusal later in the call leaves
   * no `attempt.opened` behind.
   */
  function workerTarget(taskId: string, { redo }: { redo: boolean }) {
    known(taskId);
    const t = taskOf(taskId);
    const status = t?.status ?? "pending";
    if (status === "under-review") {
      throw new Refusal(`${taskId} is under review: only the check thread writes to it.`);
    }
    if ((status === "stale" || status === "failed") && !redo) {
      throw new Refusal(
        `${taskId} is ${status}: call checklist in-progress to redo it, then write to it.`,
      );
    }
    const needsAttempt = status === "pending" || status === "stale" || status === "failed";
    return (c: Caller) =>
      needsAttempt ? openAttempt(c, taskId) : Promise.resolve(t?.attemptId ?? "");
  }

  /** The task a check thread checks, which is the only one it may write to. */
  function checkedTask(c: Caller, taskId: string): FoldedTask {
    const t = view().tasks.find((x) => x.threads.check === c.threadId);
    if (!t) throw new Refusal("This thread is not checking a task.");
    if (t.id !== taskId) {
      throw new Refusal(`You are checking ${t.id}; you can write only to it, not to ${taskId}.`);
    }
    if (t.status !== "under-review") {
      throw new Refusal(`${t.id} is no longer under review; stop here.`);
    }
    return t;
  }

  /** Stale marks on each transitive dependent that has an attempt and isn't stale yet. */
  async function staleDependents(threadId: string, prefix: string, taskId: string, why: string) {
    const current = view().tasks;
    const marked: string[] = [];
    for (const dep of transitiveDependents(plan, taskId)) {
      const t = current.find((x) => x.id === dep);
      if (!t || t.status === "stale") continue;
      await append(
        threadId,
        "task",
        { taskId: dep, attemptId: t.attemptId, status: "stale", reason: why, by: rule("stale") },
        `${prefix}:stale:${dep}`,
      );
      // A stale mark on a task under review stops its check thread; no check-result follows.
      if (t.status === "under-review" && t.threads.check) stopThread(t.threads.check);
      marked.push(dep);
    }
    return marked;
  }

  const hashed = async (taskId: string, files: Pick<EvidenceRef, "root" | "path">[]) =>
    Promise.all(
      files.map(
        async (f): Promise<EvidenceRef> => ({
          root: f.root,
          path: f.path,
          sha256: await evidence.keep(runId, taskId, f),
        }),
      ),
    );

  const done = (message: string, eventId?: string): TaskToolResult => ({
    message,
    ...(eventId && { eventId }),
  });

  /** A correction: a revision, the stale event itself, and a stale mark on each dependent. */
  async function correct(
    threadId: string,
    trigger: string,
    taskId: string,
    reason: string,
    by: By,
  ): Promise<TaskToolResult> {
    const t = taskOf(taskId);
    if (!t) throw new Refusal(`${taskId} has no attempt to correct.`);
    const prefix = `${threadId}:${trigger}`;
    await append(
      threadId,
      "revision.started",
      { reason: "correction", taskId },
      `${prefix}:revision`,
    );
    await append(
      threadId,
      "task",
      { taskId, attemptId: t.attemptId, status: "stale", reason, by },
      prefix,
    );
    const marked = await staleDependents(
      threadId,
      prefix,
      taskId,
      `${taskId} was corrected, so this result may no longer hold.`,
    );
    return done(
      `${taskId} is stale${marked.length > 0 ? `; also stale: ${marked.join(", ")}` : ""}.`,
      prefix,
    );
  }

  return {
    view,
    taskOf,

    /** Writes the run's first event, carrying the plan. A resumed run already has it. */
    start: () =>
      section(() =>
        append(
          rootThreadId,
          "revision.started",
          {
            reason: "run",
            plan: {
              tasks: plan.map((t) => ({
                id: t.id,
                dependsOn: [...t.dependsOn],
                outputs: t.outputs,
              })),
            },
          },
          `${rootThreadId}:revision`,
        ),
      ),

    checklist: (c: Caller, input: ChecklistInput) =>
      section(async () => {
        const { taskId, status, reason } = input;
        known(taskId);
        const kind = kindOf(c.threadId);
        if (kind === "supervisor") {
          if (status !== "stale" && status !== "to-check") {
            throw new Refusal("The supervisor sets only stale or to-check.");
          }
          const t = taskOf(taskId);
          if (!t || t.status === "stale" || t.status === "failed") {
            throw new Refusal(`${taskId} has no live attempt; only a worker starts one.`);
          }
          if (t.status === "under-review") {
            throw new Refusal(`${taskId} is under review: only the check thread writes to it.`);
          }
          if (status === "stale") return correct(c.threadId, c.toolCallId, taskId, reason, AGENT);
          await append(
            c.threadId,
            "task",
            { taskId, attemptId: t.attemptId, status, reason, by: AGENT },
            `${c.threadId}:${c.toolCallId}`,
          );
          return done(`${taskId} is ${status}.`, `${c.threadId}:${c.toolCallId}`);
        }
        if (kind !== "worker")
          throw new Refusal("Only a worker or the supervisor sets a task's status.");
        if (status === "stale") throw new Refusal("Only the supervisor marks a task stale.");
        const current = taskOf(taskId)?.status ?? "pending";
        if (status === "in-progress") {
          if (current === "in-progress") return done(`${taskId} is already in progress.`);
          if (current === "done" || current === "to-check") {
            throw new Refusal(
              `${taskId} is ${current}: a redo goes through a stale mark from the supervisor.`,
            );
          }
        }
        if (status === "done") {
          const t = taskOf(taskId);
          const missing =
            t?.missingRequired ??
            known(taskId)
              .outputs.filter((o) => o.required)
              .map((o) => o.id);
          if (missing.length > 0) {
            throw new Refusal(
              `${taskId} cannot be done: required outputs not reported: ${missing.join(", ")}. Report them with report_output, or set to-check or failed.`,
            );
          }
        }
        const attemptOf = workerTarget(taskId, { redo: status === "in-progress" });
        const attemptId = await attemptOf(c);
        const id = `${c.threadId}:${c.toolCallId}`;
        await append(c.threadId, "task", { taskId, attemptId, status, reason, by: AGENT }, id);
        return done(`${taskId} is ${status}.`, id);
      }),

    checkpoint: (c: Caller, input: CheckpointInput) =>
      section(async () => {
        const { taskId, text, verdict, toCheck } = input;
        const kind = kindOf(c.threadId);
        if (kind !== "worker" && kind !== "check") {
          throw new Refusal("Only a worker or a check thread writes checkpoints.");
        }
        if (kind === "worker" && verdict) {
          throw new Refusal("Only a check thread sets a verdict.");
        }
        const attemptOf =
          kind === "check"
            ? (
                (t) => () =>
                  Promise.resolve(t.attemptId)
              )(checkedTask(c, taskId))
            : workerTarget(taskId, { redo: false });
        const refs = await hashed(taskId, input.evidence);
        const attemptId = await attemptOf(c);
        const id = `${c.threadId}:${c.toolCallId}`;
        await append(
          c.threadId,
          "checkpoint",
          {
            taskId,
            attemptId,
            text,
            by: AGENT,
            evidence: refs,
            ...(verdict && { verdict }),
            ...(toCheck && { toCheck }),
          },
          id,
        );
        return done("Checkpoint recorded.", id);
      }),

    reportOutput: (c: Caller, input: ReportOutputInput) =>
      section(async () => {
        const { taskId, outputId, title, output } = input;
        const kind = kindOf(c.threadId);
        if (kind !== "worker" && kind !== "check") {
          throw new Refusal("Only a worker or a check thread reports outputs.");
        }
        const attemptOf =
          kind === "check"
            ? (
                (t) => () =>
                  Promise.resolve(t.attemptId)
              )(checkedTask(c, taskId))
            : workerTarget(taskId, { redo: false });
        const declared = known(taskId).outputs.find((o) => o.id === outputId);
        const problem =
          declarationProblem(declared, { title, output }) ??
          referenceProblem(view(), taskId, output);
        if (problem) throw new Refusal(problem);

        // Files first: a missing one fails the call before anything is appended.
        const evidenceRefs = await hashed(taskId, input.evidence);
        const own =
          output.kind === "structure"
            ? output.mesh?.file
            : output.kind === "volume"
              ? output.volume.file
              : output.kind === "file"
                ? output.file
                : undefined;
        const [file] = own ? await hashed(taskId, [own]) : [];
        // The stored output names its file with the sha256 as well; the spreads set it.
        const withFile = (
          !file
            ? output
            : output.kind === "structure"
              ? { ...output, mesh: output.mesh && { ...output.mesh, file } }
              : output.kind === "volume"
                ? { ...output, volume: { ...output.volume, file } }
                : { ...output, file }
        ) as PayloadOf<"output">["output"];

        const attemptId = await attemptOf(c);
        const id = `${c.threadId}:${c.toolCallId}`;
        const first =
          kind === "check" &&
          !recorder.events().some((e) => e.type === "output" && e.threadId === c.threadId);
        if (first) {
          await append(c.threadId, "revision.started", { reason: "fix", taskId }, `${id}:revision`);
          await staleDependents(
            c.threadId,
            id,
            taskId,
            `${taskId} was changed by the second agent, so this result may no longer hold.`,
          );
        }
        await append(
          c.threadId,
          "output",
          { taskId, attemptId, outputId, title, evidence: evidenceRefs, output: withFile },
          id,
        );
        return done(`Output ${outputId} recorded.`, id);
      }),

    /** Check start: the task goes under review before its check thread runs. Null if it can't be checked. */
    startCheck: (taskId: string, checkThreadId: string) =>
      section(async () => {
        const t = taskOf(taskId);
        if (!t || (t.status !== "done" && t.status !== "to-check")) return null;
        await append(
          checkThreadId,
          "task",
          {
            taskId,
            attemptId: t.attemptId,
            status: "under-review",
            reason: "A second agent is checking this task.",
            by: rule("check-start"),
          },
          `${checkThreadId}:start`,
        );
        return t.attemptId;
      }),

    /**
     * Check result: when the check thread ends, the task takes `checkResult` of its fold,
     * but only if it is still under review (a stale mark may have ended the review).
     */
    finishCheck: (taskId: string, checkThreadId: string) =>
      section(async () => {
        const t = taskOf(taskId);
        if (t?.status !== "under-review" || t.threads.check !== checkThreadId) return null;
        const status = checkResult(t);
        const verdict = t.checker?.verdict;
        const reason =
          status === "done"
            ? "The second agent checked this task and agrees."
            : verdict === undefined
              ? "The check ended without a verdict."
              : verdict === "needs-review"
                ? "The second agent asks for a person to look."
                : t.missingRequired.length > 0
                  ? `Required outputs are missing: ${t.missingRequired.join(", ")}.`
                  : "The check passed, but items are still open for a person.";
        await append(
          checkThreadId,
          "task",
          { taskId, attemptId: t.attemptId, status, reason, by: rule("check-result") },
          `${checkThreadId}:result`,
        );
        return { status, verdict };
      }),

    /** Tasks the worker thread left in progress. */
    inProgress: (workerThreadId: string) =>
      view().tasks.filter((t) => t.status === "in-progress" && t.threads.worker === workerThreadId),

    /** The stuck guard's last step: the task goes to check. */
    markStuck: (workerThreadId: string, taskId: string) =>
      section(async () => {
        const t = taskOf(taskId);
        if (t?.status !== "in-progress") return;
        await append(
          workerThreadId,
          "task",
          {
            taskId,
            attemptId: t.attemptId,
            status: "to-check",
            reason: "The worker stopped before finishing this task.",
            by: rule("stuck"),
          },
          `${workerThreadId}:stuck:${taskId}`,
        );
      }),

    /** The supervisor's code and judgment writes (`by` says which). `trigger` makes the ids. */
    correct: (threadId: string, trigger: string, taskId: string, reason: string, by: By) =>
      section(() => correct(threadId, trigger, taskId, reason, by)),

    /** A judgment sets a task to `to-check` or `failed`, opening an attempt if it never had one. */
    settle: (
      threadId: string,
      trigger: string,
      taskId: string,
      status: "to-check" | "failed",
      reason: string,
      by: By,
    ) =>
      section(async () => {
        known(taskId);
        const t = taskOf(taskId);
        const prefix = `${threadId}:${trigger}`;
        const attemptId = t
          ? t.attemptId
          : await openAttempt({ threadId, toolCallId: trigger }, taskId);
        if (t?.status === status) return;
        await append(threadId, "task", { taskId, attemptId, status, reason, by }, prefix);
      }),
  };
}

export type TaskRuntime = ReturnType<typeof taskRuntime>;
