/**
 * The runtime behind the task tools: every write of a `task`, `checkpoint`, `output`,
 * `attempt.opened` or `revision.started` event by a thread's tool call, under the rules in
 * `@voluma/contracts/task-tools`. The supervisor writes its own `task` events through
 * `setStatus` and `staleDependents`, inside the same `section`. Its only view of the run is
 * `fold` of the recorder's events, folded once per change of the log; it keeps no second
 * record. Each decision and its appends run inside one per-run critical section (`section`),
 * whichever thread asks, and the recorder adds an event to the view only once it is stored.
 * Slow work (hashing and copying evidence) happens outside the section, and the decision is
 * checked again inside. A thread's kind and task come from the call (`Caller`), not from the
 * log, which may not yet hold its `thread.started`. A refusal is thrown as a `Refusal`: the
 * tool turns it into the error the model reads, and nothing is appended. A store failure is
 * an ordinary error: the tool call fails, and the supervisor fails the run when its own
 * append hits one.
 */

import type { By, ThreadKind } from "@voluma/contracts/events";
import { type Folded, type FoldedTask, fold } from "@voluma/contracts/fold";
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

/** The calling tool call, and the thread's identity (`ToolContext`). */
export interface Caller {
  threadId: string;
  toolCallId: string;
  kind: ThreadKind;
  taskId?: string;
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
  /** Called for a thread whose task a stale mark has just taken from it (a check or a worker). */
  stopThread(threadId: string): void;
}

const AGENT: By = { kind: "agent" };

/** Who a call writes as, and the attempt it writes to. */
interface Target {
  kind: "worker" | "check";
  attempt(): Promise<string>;
}

type OutputInput = ReportOutputInput["output"];
type FileInput = Extract<OutputInput, { kind: "file" }>["file"];

/** The stored output: the file it names as its own is kept, and carries its sha256. */
async function storedOutput(
  output: OutputInput,
  keepFile: (file: FileInput) => Promise<EvidenceRef>,
): Promise<PayloadOf<"output">["output"]> {
  switch (output.kind) {
    case "structure": {
      const { mesh, ...rest } = output;
      return mesh ? { ...rest, mesh: { ...mesh, file: await keepFile(mesh.file) } } : rest;
    }
    case "volume":
      return { ...output, volume: { ...output.volume, file: await keepFile(output.volume.file) } };
    case "file":
      return { ...output, file: await keepFile(output.file) };
    default:
      return output;
  }
}

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

  // The log only grows, so its length says whether the fold is current.
  let folded: { length: number; value: Folded } | undefined;
  const view = (): Folded => {
    const events = recorder.events();
    if (folded?.length !== events.length) folded = { length: events.length, value: fold(events) };
    return folded.value;
  };
  const taskOf = (id: string): FoldedTask | undefined => view().tasks.find((t) => t.id === id);

  const known = (taskId: string) => {
    const t = planned.get(taskId);
    if (!t) throw new Refusal(`${taskId} is not a task of this run's plan`);
    return t;
  };

  /** One `task` event: `id` makes it a no-op when written twice. */
  const setStatus = (
    threadId: string,
    id: string,
    taskId: string,
    attemptId: string,
    status: FoldedTask["status"],
    reason: string,
    by: By,
  ) => recorder.append(threadId, "task", { taskId, attemptId, status, reason, by }, id);

  async function openAttempt(c: Caller, taskId: string): Promise<string> {
    const id = `${c.threadId}:${c.toolCallId}:open`;
    await recorder.append(c.threadId, "attempt.opened", { taskId }, id);
    return id;
  }

  /**
   * Who a call writes as and where. A worker writes only to its own task, and its target
   * opens a new attempt when the task has none (or is `stale` or `failed` and `redo`),
   * only once every task this one builds on is done (the rule `readyTasks` uses), so a
   * refusal later in the call leaves no `attempt.opened` behind. A check thread writes to the
   * attempt under review; only it sets a verdict.
   */
  function writeTarget(
    c: Caller,
    taskId: string,
    { redo, verdict, what }: { redo: boolean; verdict: boolean; what: string },
  ): Target {
    known(taskId);
    if (c.kind === "check") {
      if (c.taskId !== taskId) {
        throw new Refusal(
          `You are checking ${c.taskId}; you can write only to it, not to ${taskId}.`,
        );
      }
      const t = taskOf(taskId);
      // The check thread's own `thread.started` may not be stored yet, so an unset one is this thread's.
      if (t?.status !== "under-review" || (t.threads.check && t.threads.check !== c.threadId)) {
        throw new Refusal(`${taskId} is no longer under review; stop here.`);
      }
      return { kind: "check", attempt: async () => t.attemptId };
    }
    if (c.kind !== "worker") throw new Refusal(`Only a worker or a check thread ${what}.`);
    if (verdict) throw new Refusal("Only a check thread sets a verdict.");
    if (c.taskId !== taskId) {
      throw new Refusal(`You work on ${c.taskId}; you can write only to it, not to ${taskId}.`);
    }
    const t = taskOf(taskId);
    const status = t?.status ?? "pending";
    if (status === "under-review") {
      throw new Refusal(`${taskId} is under review: only the check thread writes to it.`);
    }
    if ((status === "stale" || status === "failed") && !redo) {
      throw new Refusal(
        `${taskId} is ${status}${t?.reason ? ` (${t.reason})` : ""}: call checklist in-progress to redo it, then write to it.`,
      );
    }
    const needsAttempt = status === "pending" || status === "stale" || status === "failed";
    if (needsAttempt) {
      const waiting = known(taskId).dependsOn.filter((d) => taskOf(d)?.status !== "done");
      if (waiting.length > 0) {
        throw new Refusal(`${taskId} builds on ${waiting.join(", ")}, which is not done yet.`);
      }
    }
    return {
      kind: "worker",
      attempt: needsAttempt ? () => openAttempt(c, taskId) : async () => t?.attemptId ?? "",
    };
  }

  /**
   * A write that needs slow work first (hashing and copying evidence). The target is checked
   * before it, so a refused call copies nothing, and again inside the section.
   */
  async function write<P>(
    target: () => Target,
    prepare: () => Promise<P>,
    append: (target: Target, prepared: P) => Promise<TaskToolResult>,
  ): Promise<TaskToolResult> {
    target();
    const prepared = await prepare();
    return section(() => append(target(), prepared));
  }

  /** Stale marks on each transitive dependent that has an attempt and isn't stale yet. */
  async function staleDependents(threadId: string, prefix: string, taskId: string, why: string) {
    const current = view().tasks;
    const marked: string[] = [];
    for (const dep of transitiveDependents(plan, taskId)) {
      const t = current.find((x) => x.id === dep);
      if (!t || t.status === "stale") continue;
      await setStatus(threadId, `${prefix}:stale:${dep}`, dep, t.attemptId, "stale", why, {
        kind: "rule",
        rule: "stale",
      });
      // A stale mark stops the dependent's live thread: a check (no check-result follows) or
      // a worker, which must not redo the task ahead of what it builds on.
      if (t.status === "under-review" && t.threads.check) stopThread(t.threads.check);
      else if (t.status === "in-progress" && t.threads.worker) stopThread(t.threads.worker);
      marked.push(dep);
    }
    return marked;
  }

  const keep = async (
    taskId: string,
    f: Pick<EvidenceRef, "root" | "path">,
  ): Promise<EvidenceRef> => ({
    root: f.root,
    path: f.path,
    sha256: await evidence.keep(runId, taskId, f),
  });

  const done = (message: string, eventId?: string): TaskToolResult => ({
    message,
    ...(eventId && { eventId }),
  });

  return {
    view,
    taskOf,
    section,
    setStatus,
    staleDependents,

    /** Writes the run's first event, carrying the plan. A resumed run already has it. */
    start: () =>
      section(() =>
        recorder.append(
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
        if (c.kind !== "worker") throw new Refusal("Only a worker sets a task's status.");
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
          const missing =
            taskOf(taskId)?.missingRequired ??
            known(taskId)
              .outputs.filter((o) => o.required)
              .map((o) => o.id);
          if (missing.length > 0) {
            throw new Refusal(
              `${taskId} cannot be done: required outputs not reported: ${missing.join(", ")}. Report them with report_output, or set to-check or failed.`,
            );
          }
        }
        const target = writeTarget(c, taskId, {
          redo: status === "in-progress",
          verdict: false,
          what: "sets a task's status",
        });
        const id = `${c.threadId}:${c.toolCallId}`;
        await setStatus(c.threadId, id, taskId, await target.attempt(), status, reason, AGENT);
        return done(`${taskId} is ${status}.`, id);
      }),

    checkpoint: (c: Caller, input: CheckpointInput) => {
      const { taskId, text, verdict, toCheck } = input;
      return write(
        () =>
          writeTarget(c, taskId, {
            redo: false,
            verdict: verdict !== undefined,
            what: "writes checkpoints",
          }),
        () => Promise.all(input.evidence.map((f) => keep(taskId, f))),
        async (target, refs) => {
          const id = `${c.threadId}:${c.toolCallId}`;
          await recorder.append(
            c.threadId,
            "checkpoint",
            {
              taskId,
              attemptId: await target.attempt(),
              text,
              by: AGENT,
              evidence: refs,
              ...(verdict && { verdict }),
              ...(toCheck && { toCheck }),
            },
            id,
          );
          return done("Checkpoint recorded.", id);
        },
      );
    },

    reportOutput: (c: Caller, input: ReportOutputInput) => {
      const { taskId, outputId, title, output } = input;
      const target = () => {
        const t = writeTarget(c, taskId, { redo: false, verdict: false, what: "reports outputs" });
        const declared = known(taskId).outputs.find((o) => o.id === outputId);
        const problem =
          declarationProblem(declared, { title, output }) ??
          referenceProblem(view(), taskId, output);
        if (problem) throw new Refusal(problem);
        return t;
      };
      // Files first, outside the section: a missing one fails the call before anything is
      // appended, and a copy does not hold up the run's other task writes.
      const prepare = async () => ({
        evidenceRefs: await Promise.all(input.evidence.map((f) => keep(taskId, f))),
        output: await storedOutput(output, (f) => keep(taskId, f)),
      });
      return write(target, prepare, async (t, prepared) => {
        const attemptId = await t.attempt();
        const id = `${c.threadId}:${c.toolCallId}`;
        const first =
          t.kind === "check" &&
          !recorder.events().some((e) => e.type === "output" && e.threadId === c.threadId);
        if (first) {
          await recorder.append(
            c.threadId,
            "revision.started",
            { reason: "fix", taskId },
            `${id}:revision`,
          );
          await staleDependents(
            c.threadId,
            id,
            taskId,
            `${taskId} was changed by the second agent, so this result may no longer hold.`,
          );
        }
        await recorder.append(
          c.threadId,
          "output",
          {
            taskId,
            attemptId,
            outputId,
            title,
            evidence: prepared.evidenceRefs,
            output: prepared.output,
          },
          id,
        );
        return done(`Output ${outputId} recorded.`, id);
      });
    },
  };
}

export type TaskRuntime = ReturnType<typeof taskRuntime>;
