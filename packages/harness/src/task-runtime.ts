/**
 * The runtime behind the task tools: every write of a `task`, `checkpoint`, `output`, `ask`,
 * `attempt.opened` or `revision.started` event by a thread's tool call, under the rules in
 * `@voluma/contracts/task-tools`. The run loop and the main agent's tools write their own
 * events through `setStatus`, `openAttempt` and `stop`, inside the same `section`. Its only view of the run is
 * `fold` of the recorder's events, folded once per change of the log; it keeps no second
 * record. Each decision and its appends run inside one per-run critical section (`section`),
 * whichever thread asks, and the recorder adds an event to the view only once it is stored.
 * Slow work (hashing and copying evidence) happens outside the section, and the decision is
 * checked again inside. A thread's kind and task come from the call (`Caller`), not from the
 * log, which may not yet hold its `thread.started`. A refusal is thrown as a `Refusal`: the
 * tool turns it into the error the model reads, and nothing is appended. A store failure is
 * an ordinary error: the tool call fails, and the run loop fails the run when its own
 * append hits one.
 */

import type { By, RunEvent, ThreadKind } from "@voluma/contracts/events";
import { type Folded, type FoldedTask, fold } from "@voluma/contracts/fold";
import type { EvidenceRef } from "@voluma/contracts/output";
import type {
  AskInput,
  CheckpointInput,
  ReportOutputInput,
  SubmitTaskInput,
  TaskToolResult,
} from "@voluma/contracts/task-tools";
import type { WorkflowPlan } from "@voluma/contracts/workflow";
import { isSatisfied, transitiveDependents } from "@voluma/workflow";
import type { ThreadLayout } from "./layout";
import { declarationProblem, placementProblem, referenceProblem } from "./output-checks";
import type { Evidence } from "./ports/evidence";
import type { PayloadOf, Recorder } from "./recorder";
import { startedFor, threadLog } from "./thread-log";

/** A check thread may ask the main agent this many questions. */
export const MAX_ASKS = 3;

/** A plan task as the workflow declares it (`workflowPlanSchema`). */
export type PlanTask = WorkflowPlan["tasks"][number];

/** The calling tool call, and the thread's identity (`ToolContext`). */
export interface Caller {
  threadId: string;
  toolCallId: string;
  kind: ThreadKind;
  taskId?: string;
  /** How many tool calls the reply that made this call holds (`ToolContext.batchSize`). */
  batchSize: number;
}

/** The call broke a rule; the message is what the model reads. */
export class Refusal extends Error {}

export interface TaskRuntimeOptions {
  recorder: Recorder;
  evidence: Evidence;
  runId: string;
  /**
   * The calling thread's view of the files: evidence it names must be readable through it. The
   * layout asks `cited` for a checker's reads of the worker's scratch.
   */
  layoutOf(threadId: string, cited: (path: string) => boolean): ThreadLayout;
  /** The thread under which the run's first event is written. */
  rootThreadId: string;
  /** The plan the run starts with (written by `start`); later plans are `view().plan` (`plan.changed`). */
  plan: readonly PlanTask[];
  /**
   * Aborts the thread if it runs here; never waits for it. The runtime has stored its end
   * first (`stop`), so its next write is refused whatever it was doing.
   */
  abortThread(threadId: string): void;
}

const AGENT: By = { kind: "agent" };

/** Who a call writes as, and the attempt it writes to. */
interface Target {
  attempt(): Promise<string>;
  /** The call opens a new attempt, so the fold's view of the current one does not apply. */
  fresh: boolean;
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
      const s = output.structure;
      return "mask" in s
        ? { ...output, structure: { ...s, mask: await keepFile(s.mask) } }
        : (output as PayloadOf<"output">["output"]);
    }
    case "surface":
      return {
        ...output,
        surface: { ...output.surface, heights: await keepFile(output.surface.heights) },
      };
    case "volume":
      return { ...output, volume: { ...output.volume, file: await keepFile(output.volume.file) } };
    case "file":
      return { ...output, file: await keepFile(output.file) };
    default:
      return output;
  }
}

/** Scratch files (after `/scratch/`) the main agent attached to answers for the check threads of `taskId`. */
function answeredFiles(events: readonly RunEvent[], taskId: string): Set<string> {
  const checks = new Set(
    events.flatMap((e) =>
      e.type === "thread.started" && e.payload.kind === "check" && e.payload.task === taskId
        ? [e.threadId]
        : [],
    ),
  );
  return new Set(
    events.flatMap((e) =>
      e.type === "answer" && checks.has(e.payload.checkThreadId)
        ? (e.payload.files ?? []).flatMap((f) => (f.root === "scratch" ? [f.path] : []))
        : [],
    ),
  );
}

export function taskRuntime(options: TaskRuntimeOptions) {
  const { recorder, evidence, runId, layoutOf, rootThreadId, abortThread } = options;

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
  /** The plan now, with every `plan.changed` applied. */
  const planNow = () => view().plan.tasks;

  /**
   * Whether the attempt of `taskId` cites this scratch file (the path after `/scratch/`): a
   * checkpoint or output of it, or a file the main agent attached to an answer for its check.
   */
  const cites = (taskId: string, path: string) =>
    !!taskOf(taskId)?.citedScratch.includes(path) ||
    answeredFiles(recorder.events(), taskId).has(path);

  const known = (taskId: string) => {
    const t = planNow().find((p) => p.id === taskId);
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

  const attempted = (taskId: string) =>
    transitiveDependents(planNow(), taskId).filter((dep) => {
      const t = taskOf(dep);
      return t?.attemptId && t.status !== "stale";
    });

  /**
   * The one way an attempt opens: `attempt.opened` under `holderThreadId`, id `eventId`. A task
   * that already had a result and has dependents with an attempt first starts a correction
   * revision and marks them stale (stopping their live threads). Call inside `section`.
   */
  async function openAttempt(taskId: string, holderThreadId: string, eventId: string) {
    if (taskOf(taskId)?.attemptId && attempted(taskId).length > 0) {
      await recorder.append(
        holderThreadId,
        "revision.started",
        { reason: "correction", taskId },
        `${eventId}:revision`,
      );
      await staleDependents(
        holderThreadId,
        eventId,
        taskId,
        `${taskId} was corrected, so this result may no longer hold.`,
      );
    }
    await recorder.append(holderThreadId, "attempt.opened", { taskId }, eventId);
    return eventId;
  }

  /**
   * Stores the thread's end as cancelled, then aborts it without waiting: it is stopped from
   * this moment, and its own later end is dropped. A thread already stopped is left alone.
   * Call inside `section`; `eventId` derives from what stops it.
   */
  async function stop(threadId: string, eventId: string) {
    const record = threadLog(recorder.events()).threads.get(threadId);
    if (record && record.end?.status !== "cancelled") {
      await recorder.append(threadId, "thread.ended", { status: "cancelled" }, eventId);
    }
    abortThread(threadId);
  }

  /**
   * Who a call writes as and where. A check thread writes to the attempt under review; only it
   * sets a verdict. A worker writes only to its own task, the main agent to any it may hold.
   * The current attempt takes the write when the caller opened it, it has no verdict yet and
   * the task is not stale or failed. Otherwise the caller's write opens a new attempt, if the
   * caller is eligible (the task's latest non-stopped worker; the main agent when no worker of
   * the task is live) and every task this one builds on is satisfied. Nothing is opened until
   * the call is sure to write (`attempt()`), so a refusal later leaves no `attempt.opened` behind.
   */
  function writeTarget(
    c: Caller,
    taskId: string,
    { verdict, what }: { verdict: boolean; what: string },
  ): Target {
    known(taskId);
    const log = threadLog(recorder.events());
    if (log.threads.get(c.threadId)?.end?.status === "cancelled") {
      throw new Refusal("You were stopped; stop here.");
    }
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
      const attemptId = t.attemptId;
      if (!attemptId) throw new Refusal(`${taskId} has no attempt to check.`);
      return { attempt: async () => attemptId, fresh: false };
    }
    if (c.kind !== "worker" && c.kind !== "main") {
      throw new Refusal(`Only a worker, the main agent or a check thread ${what}.`);
    }
    if (verdict) throw new Refusal("Only a check thread sets a verdict.");
    if (c.kind === "worker" && c.taskId !== taskId) {
      throw new Refusal(`You work on ${c.taskId}; you can write only to it, not to ${taskId}.`);
    }
    const t = taskOf(taskId);
    const status = t?.status ?? "pending";
    if (t?.skipped) throw new Refusal(`${taskId} was skipped: ${t.skipped.reason}`);
    if (status === "under-review") {
      throw new Refusal(`${taskId} is under review: only the check thread writes to it.`);
    }
    const attemptId = t?.attemptId;
    if (
      attemptId &&
      log.holders.get(taskId) === c.threadId &&
      !t.checker &&
      status !== "stale" &&
      status !== "failed"
    ) {
      return { attempt: async () => attemptId, fresh: false };
    }
    const workers = startedFor(log, taskId, "worker").filter((r) => r.end?.status !== "cancelled");
    if (c.kind === "main") {
      if (workers.length > 0) {
        throw new Refusal(
          `${taskId} has a worker (${workers[0]?.id}); it is not yours to write to.`,
        );
      }
    } else {
      // Its own `thread.started` may not be stored yet: a thread not in the log is the newest.
      const latest = workers.at(-1);
      if (latest && latest.id !== c.threadId && log.threads.has(c.threadId)) {
        throw new Refusal(`${taskId} is held by a newer worker (${latest.id}); stop here.`);
      }
    }
    const waiting = known(taskId).dependsOn.filter((d) => !isSatisfied(taskOf(d)));
    if (waiting.length > 0) {
      throw new Refusal(
        `${taskId} builds on ${waiting.join(", ")}, which has no usable result yet.`,
      );
    }
    return {
      attempt: () => openAttempt(taskId, c.threadId, `${c.threadId}:${c.toolCallId}:open`),
      fresh: true,
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
    const marked: string[] = [];
    for (const dep of attempted(taskId)) {
      const t = taskOf(dep);
      if (!t?.attemptId) continue;
      await setStatus(threadId, `${prefix}:stale:${dep}`, dep, t.attemptId, "stale", why, {
        kind: "rule",
        rule: "stale",
      });
      // A stale mark stops the dependent's live thread: a check (no check-result follows) or
      // a worker, which must not redo the task ahead of what it builds on.
      const holder =
        t.status === "under-review"
          ? t.threads.check
          : t.status === "in-progress"
            ? t.threads.worker
            : undefined;
      if (holder) await stop(holder, `${prefix}:stale:${dep}:end`);
      marked.push(dep);
    }
    return marked;
  }

  /** Keeps a file the calling thread named, if its own layout lets it read that path. */
  const keep = async (
    c: Caller,
    taskId: string,
    f: Pick<EvidenceRef, "root" | "path">,
  ): Promise<EvidenceRef> => {
    const path = f.root === "scratch" ? `/scratch/${f.path}` : `/outputs/${taskId}/${f.path}`;
    try {
      layoutOf(c.threadId, (p) => cites(taskId, p)).keyOf(path, "read");
    } catch (error) {
      throw new Refusal(
        `Evidence ${path} is not a file you can read: ${error instanceof Error ? error.message : error}`,
      );
    }
    return { root: f.root, path: f.path, sha256: await evidence.keep(runId, taskId, f) };
  };

  const done = (message: string, eventId?: string): TaskToolResult => ({
    message,
    ...(eventId && { eventId }),
  });

  return {
    view,
    taskOf,
    cites,
    section,
    setStatus,
    staleDependents,
    openAttempt,
    stop,
    keep,

    /** Writes the run's first event, carrying the plan. A resumed run already has it. */
    start: () =>
      section(() =>
        recorder.append(
          rootThreadId,
          "revision.started",
          {
            reason: "run",
            plan: {
              tasks: [...options.plan],
            },
          },
          `${rootThreadId}:revision`,
        ),
      ),

    /**
     * The holder hands its task to the check: `task under-review` with the summary as its
     * reason. The caller ends its turn. Refused with other tools in the batch (the turn would
     * not end), and while a required output is unreported.
     */
    submitTask: (c: Caller, input: SubmitTaskInput) =>
      section(async () => {
        const { taskId, summary } = input;
        if (c.batchSize > 1) throw new Refusal("Call submit_task alone, not with other tools.");
        const target = writeTarget(c, taskId, { verdict: false, what: "submits tasks" });
        const missing = target.fresh
          ? known(taskId)
              .outputs.filter((o) => o.required)
              .map((o) => o.id)
          : (taskOf(taskId)?.missingRequired ?? []);
        if (missing.length > 0) {
          throw new Refusal(
            `${taskId} cannot be submitted: required outputs not reported: ${missing.join(", ")}. Report them with report_output, or report them missing with the reason.`,
          );
        }
        const id = `${c.threadId}:${c.toolCallId}`;
        await setStatus(
          c.threadId,
          id,
          taskId,
          await target.attempt(),
          "under-review",
          summary,
          AGENT,
        );
        return done(`${taskId} is submitted for checking. Your turn ends here.`, id);
      }),

    /** A check thread's question to the main agent; it ends its turn and the answer resumes it. */
    ask: (c: Caller, input: AskInput) =>
      section(async () => {
        if (c.kind !== "check" || !c.taskId) throw new Refusal("Only a check thread asks.");
        if (c.batchSize > 1) throw new Refusal("Call ask alone, not with other tools.");
        writeTarget(c, c.taskId, { verdict: false, what: "asks" });
        const asked = threadLog(recorder.events()).threads.get(c.threadId)?.asks.length ?? 0;
        if (asked >= MAX_ASKS) {
          throw new Refusal(`You have asked ${MAX_ASKS} questions; give your verdict now.`);
        }
        const id = `${c.threadId}:${c.toolCallId}:ask`;
        await recorder.append(c.threadId, "ask", { question: input.question }, id);
        return done("Question sent. Your turn ends here; the answer resumes you.", id);
      }),

    checkpoint: (c: Caller, input: CheckpointInput) => {
      const { taskId, text, summary, verdict, toCheck } = input;
      return write(
        () =>
          writeTarget(c, taskId, {
            verdict: verdict !== undefined,
            what: "writes checkpoints",
          }),
        () => Promise.all(input.evidence.map((f) => keep(c, taskId, f))),
        async (target, refs) => {
          const id = `${c.threadId}:${c.toolCallId}`;
          await recorder.append(
            c.threadId,
            "checkpoint",
            {
              taskId,
              attemptId: await target.attempt(),
              text,
              summary,
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
        if (c.kind === "check") {
          throw new Refusal(
            "A check thread does not report outputs: put the values you re-derived in your checkpoint's text.",
          );
        }
        const t = writeTarget(c, taskId, { verdict: false, what: "reports outputs" });
        const declared = known(taskId).outputs.find((o) => o.id === outputId);
        const problem =
          declarationProblem(declared, { title, output }) ??
          referenceProblem(view(), taskId, output) ??
          placementProblem(view(), planNow(), { outputId, output });
        if (problem) throw new Refusal(problem);
        return t;
      };
      // Files first, outside the section: a missing one fails the call before anything is
      // appended, and a copy does not hold up the run's other task writes.
      const prepare = async () => ({
        evidenceRefs: await Promise.all(input.evidence.map((f) => keep(c, taskId, f))),
        output: await storedOutput(output, (f) => keep(c, taskId, f)),
      });
      return write(target, prepare, async (t, prepared) => {
        const attemptId = await t.attempt();
        const id = `${c.threadId}:${c.toolCallId}`;
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
