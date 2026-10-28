/**
 * The supervisor: routine wakes are code, judgment goes through one seam (`judgment.ts`).
 * It starts a worker for each ready task (`@voluma/workflow`'s graph over the folded run),
 * wakes a worker that stopped with its task unfinished up to a limit and then lets the
 * stuck guard mark the task, starts a check thread on a task that is done or to check, and
 * writes the check's result. A check that did not pass, or a thread that failed, is a
 * judgment point; a redo is a correction (a stale mark on the task and its dependents), after
 * which the task is ready again. Every decision is an event (`by` rule or judgment), written
 * through the task runtime. It runs until nothing is running and nothing is ready.
 */
import type { By } from "@voluma/contracts/events";
import type { Folded } from "@voluma/contracts/fold";
import { readyTasks } from "@voluma/workflow";
import type { ThreadOutcome } from "./adapters/pi/start-thread";
import type { Judgment, JudgmentPoint } from "./judgment";
import type { PayloadOf, Recorder } from "./recorder";
import type { PlanTask, TaskRuntime } from "./task-runtime";
import type { ThreadSpec, Threads } from "./threads";

/** What the caller decides about a worker or check thread; the supervisor adds its identity. */
export type RoleSpec = Pick<ThreadSpec, "prompt" | "model" | "streamFn" | "systemPrompt" | "tools">;

export interface SupervisorOptions {
  runId: string;
  /** The supervisor's own thread: the root, and the envelope of its events. */
  threadId: string;
  plan: readonly PlanTask[];
  runtime: TaskRuntime;
  recorder: Recorder;
  threads: Threads;
  judgment: Judgment;
  worker(taskId: string): RoleSpec;
  check(taskId: string): RoleSpec;
  /** Wakes of a worker that stopped with its task unfinished before the stuck guard marks it. */
  stuckLimit?: number;
  /** Redos a judgment may order for one task. */
  maxRedos?: number;
  signal?: AbortSignal;
}

export function supervisor(options: SupervisorOptions) {
  const { threadId: root, plan, runtime, threads, judgment, signal } = options;
  const stuckLimit = options.stuckLimit ?? 2;
  const maxRedos = options.maxRedos ?? 1;
  const by: By = { kind: "judgment", arm: judgment.arm };

  const active = new Set<string>(); // tasks with a worker or check thread in flight
  const running = new Set<Promise<void>>();
  const starts = new Map<string, number>(); // `${taskId}.${role}` → threads started
  const wakes = new Map<string, number>(); // worker thread → wakes so far
  const redos = new Map<string, number>(); // task → redos ordered

  const nextThread = (taskId: string, role: "worker" | "check") => {
    const n = (starts.get(`${taskId}.${role}`) ?? 0) + 1;
    starts.set(`${taskId}.${role}`, n);
    // History is keyed by thread id alone, so the id carries the run.
    return `${options.runId}.${taskId}.${role}${n === 1 ? "" : `.${n}`}`;
  };

  /** `body` returns whether a successor thread took over the task. */
  function watch(taskId: string, body: () => Promise<boolean>) {
    const p: Promise<void> = body()
      .then((successor) => {
        if (!successor) active.delete(taskId);
      })
      .finally(() => running.delete(p));
    running.add(p);
  }

  const watchWorker = (taskId: string, threadId: string, done: Promise<ThreadOutcome>) =>
    watch(taskId, async () => onWorkerEnd(taskId, threadId, await done));
  const watchCheck = (taskId: string, threadId: string, done: Promise<ThreadOutcome>) =>
    watch(taskId, async () => onCheckEnd(taskId, threadId, await done));

  function startWorker(taskId: string) {
    active.add(taskId);
    const threadId = nextThread(taskId, "worker");
    const { done } = threads.start({
      ...options.worker(taskId),
      threadId,
      kind: "worker",
      parentThreadId: root,
      taskId,
    });
    watchWorker(taskId, threadId, done);
  }

  async function startCheck(taskId: string): Promise<boolean> {
    const threadId = nextThread(taskId, "check");
    const attemptId = await runtime.startCheck(taskId, threadId);
    if (!attemptId) return false;
    const { done } = threads.start({
      ...options.check(taskId),
      threadId,
      kind: "check",
      parentThreadId: root,
      taskId,
      attemptId,
    });
    watchCheck(taskId, threadId, done);
    return true;
  }

  /** What a judgment is shown about the task. */
  function report(taskId: string): unknown {
    const t = runtime.taskOf(taskId);
    return (
      t && {
        status: t.status,
        reason: t.reason,
        milestones: t.milestones.map((m) => m.text),
        verdict: t.checker,
        openItems: t.checks.map((c) => c.title),
        missingRequired: t.missingRequired,
      }
    );
  }

  /** Asks the judgment and applies its decision. Returns whether a worker was started for the task. */
  async function judge(point: JudgmentPoint, threadId: string): Promise<boolean> {
    let decision: Awaited<ReturnType<Judgment["decide"]>>;
    try {
      decision = await judgment.decide(point);
    } catch (error) {
      // A person can still read the task; a judgment that errored must not stall the run.
      decision = {
        action: "accept",
        reason: `The judgment failed (${String(error)}); left for a person.`,
      };
    }
    const trigger = `${threadId}:judgment`;
    const { taskId } = point;
    let { action } = decision;
    if (action === "redo" && (redos.get(taskId) ?? 0) >= maxRedos) action = "accept";
    if (action === "redo") {
      redos.set(taskId, (redos.get(taskId) ?? 0) + 1);
      if (runtime.taskOf(taskId)) {
        await runtime.correct(root, trigger, taskId, decision.reason, by);
        return false; // stale and ready: the pump starts the new worker
      }
      startWorker(taskId);
      return true;
    }
    if (action === "fail") {
      await runtime.settle(root, trigger, taskId, "failed", decision.reason, by);
    } else if (point.kind === "thread-failed") {
      await runtime.settle(root, trigger, taskId, "to-check", decision.reason, by);
    }
    return false;
  }

  async function onWorkerEnd(
    taskId: string,
    threadId: string,
    outcome: ThreadOutcome,
  ): Promise<boolean> {
    if (outcome.status === "cancelled") return false;
    if (outcome.status === "failed") {
      return judge(
        { kind: "thread-failed", taskId, error: outcome.error ?? "failed", report: report(taskId) },
        threadId,
      );
    }
    {
      const unfinished = runtime.inProgress(threadId);
      if (unfinished.length > 0 || !runtime.taskOf(taskId)) {
        const n = wakes.get(threadId) ?? 0;
        if (n < stuckLimit) {
          wakes.set(threadId, n + 1);
          const text = `You stopped, but ${taskId} is not finished. Report its outputs and set its status with checklist (done, to-check or failed).`;
          watchWorker(
            taskId,
            threadId,
            threads.resume(threadId, { text, sender: { kind: "runtime" } }).done,
          );
          return true;
        }
        for (const t of unfinished) await runtime.markStuck(threadId, t.id);
        if (!runtime.taskOf(taskId)) {
          return judge(
            {
              kind: "thread-failed",
              taskId,
              error: "the worker ended without touching its task",
              report: null,
            },
            threadId,
          );
        }
      }
    }
    return startCheck(taskId);
  }

  async function onCheckEnd(
    taskId: string,
    threadId: string,
    outcome: ThreadOutcome,
  ): Promise<boolean> {
    if (outcome.status === "cancelled") return false;
    if (outcome.status === "failed") {
      return judge(
        { kind: "thread-failed", taskId, error: outcome.error ?? "failed", report: report(taskId) },
        threadId,
      );
    }
    const result = await runtime.finishCheck(taskId, threadId);
    if (result && result.verdict !== "passed") {
      return judge({ kind: "check-disagreed", taskId, report: report(taskId) }, threadId);
    }
    return false;
  }

  function startReady() {
    if (signal?.aborted) return;
    const tasks = runtime.view().tasks;
    const status = (id: string) => tasks.find((t) => t.id === id)?.status ?? "pending";
    for (const taskId of readyTasks(plan, status)) {
      if (!active.has(taskId)) startWorker(taskId);
    }
  }

  return {
    /** Runs the plan to the end: every task done, failed, to check, or blocked behind one that is. */
    async run(workflows?: PayloadOf<"thread.started">["workflows"]): Promise<Folded> {
      const { recorder } = options;
      recorder.emit(root, "thread.started", {
        parentThreadId: null,
        kind: "supervisor",
        ...(workflows && { workflows }),
      });
      await runtime.start();
      for (startReady(); running.size > 0; startReady()) await Promise.race(running);
      recorder.emit(root, "thread.ended", { status: signal?.aborted ? "cancelled" : "completed" });
      return runtime.view();
    },
  };
}
