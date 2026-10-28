/**
 * The supervisor: routine wakes are code, judgment goes through one seam (`judgment.ts`).
 * It starts a worker for each ready task (`@voluma/workflow`'s graph over the folded run),
 * wakes a worker that stopped with its task unfinished up to a limit and then lets the
 * stuck guard mark the task, starts a check thread on a task that is done or to check, and
 * writes the check's result. A check that did not pass, or a thread that failed, is a
 * judgment point; a redo is a correction (a stale mark on the task and its dependents), after
 * which the task is ready again. Every decision is an event (`by` rule or judgment), written
 * through the task runtime. It runs until nothing is running and nothing is ready.
 *
 * Every thread invocation is watched: a wake from `thread_message` comes through `onWake`,
 * which admits only a worker whose task is in flight (a check thread is never woken: the
 * fold resets its verdict on a second `thread.started`). An error in handling a thread's end,
 * a store failure above all, fails the run on purpose: the threads are aborted and the root
 * ends `failed`, because the runtime must not carry on from a record the store does not hold.
 */
import type { By } from "@voluma/contracts/events";
import type { Folded } from "@voluma/contracts/fold";
import { readyTasks } from "@voluma/workflow";
import type { ThreadOutcome } from "./adapters/pi/start-thread";
import type { Decision, Judgment, JudgmentPoint } from "./judgment";
import type { PayloadOf, Recorder } from "./recorder";
import type { PlanTask, TaskRuntime } from "./task-runtime";
import type { ThreadSpec, Threads } from "./threads";

/** What the caller decides about a worker or check thread; the supervisor adds its identity. */
export type RoleSpec = Pick<ThreadSpec, "prompt" | "model" | "streamFn" | "systemPrompt" | "tools">;

export interface SupervisorOptions {
  runId: string;
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
  /** How long a judgment may take before it counts as failed. */
  judgmentTimeoutMs?: number;
  signal?: AbortSignal;
}

export function supervisor(options: SupervisorOptions) {
  const { plan, runtime, threads, judgment, signal } = options;
  // The root and thread ids join their parts with '.', so no part may contain one.
  for (const part of [options.runId, ...plan.map((t) => t.id)]) {
    if (part.includes(".")) throw new Error(`"${part}" may not contain "." in a supervised run`);
  }
  /** The supervisor's own thread: the root, and the envelope of its events. */
  const root = `${options.runId}.supervisor`;
  const stuckLimit = options.stuckLimit ?? 2;
  const maxRedos = options.maxRedos ?? 1;
  const judgmentTimeoutMs = options.judgmentTimeoutMs ?? 60_000;
  const by: By = { kind: "judgment", arm: judgment.arm };

  const active = new Set<string>(); // tasks with a worker or check thread in flight
  const running = new Set<Promise<void>>();
  const starts = new Map<string, number>(); // `${taskId}.${role}` → threads started
  const wakes = new Map<string, number>(); // worker thread → wakes so far
  const redos = new Map<string, number>(); // task → redos ordered
  const ending = new Set<string>(); // worker threads whose end is being handled
  let failure: unknown; // the first error that failed the run

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
      .catch((error) => {
        failure ??= error;
        threads.abortAll();
      })
      .finally(() => running.delete(p));
    running.add(p);
  }

  const watchWorker = (taskId: string, threadId: string, done: Promise<ThreadOutcome>) =>
    watch(taskId, async () => {
      const outcome = await done;
      ending.add(threadId);
      try {
        return await onWorkerEnd(taskId, threadId, outcome);
      } finally {
        ending.delete(threadId);
      }
    });
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

  /** One bounded call to the judgment: it counts as failed if it errors or runs past the limit. */
  async function decide(point: JudgmentPoint): Promise<Decision | { error: string }> {
    const limit = AbortSignal.any([
      AbortSignal.timeout(judgmentTimeoutMs),
      ...(signal ? [signal] : []),
    ]);
    const expired = new Promise<never>((_, reject) =>
      limit.addEventListener("abort", () => reject(new Error("timed out or cancelled")), {
        once: true,
      }),
    );
    try {
      return await Promise.race([judgment.decide(point, limit), expired]);
    } catch (error) {
      return { error: String(error) };
    }
  }

  /**
   * Asks the judgment and applies its decision. Every path leaves a `task` event by the
   * judgment arm whose reason says what it decided, or why the fallback was taken (the
   * judgment errored, or a redo was over the limit), so no point is silent in the record.
   * `workerThreadId` is the thread whose end raised the point. Returns whether a worker was
   * started for the task.
   */
  async function judge(
    point: JudgmentPoint,
    workerThreadId: string,
    threadId: string,
  ): Promise<boolean> {
    const answer = await decide(point);
    const trigger = `${threadId}:judgment`;
    const { taskId } = point;
    let action: Decision["action"];
    let reason: string;
    if ("error" in answer) {
      // A person can still read the task; a judgment that failed must not stall the run.
      action = "accept";
      reason = `The judgment failed (${answer.error}); left for a person.`;
    } else if (answer.action === "redo" && (redos.get(taskId) ?? 0) >= maxRedos) {
      action = "accept";
      reason = `A redo was ordered (${answer.reason}) but ${taskId} was already redone ${maxRedos} time(s); left for a person.`;
    } else {
      ({ action, reason } = answer);
    }
    if (action === "redo") {
      redos.set(taskId, (redos.get(taskId) ?? 0) + 1);
      if (runtime.taskOf(taskId)) {
        await runtime.correct(root, trigger, taskId, reason, by);
        return false; // stale and ready: the pump starts the new worker
      }
      startWorker(taskId);
      return true;
    }
    const status = action === "fail" ? "failed" : "to-check";
    await runtime.settle(root, workerThreadId, trigger, taskId, status, reason, by);
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
        threadId,
      );
    }
    const result = await runtime.finishCheck(taskId, threadId);
    if (result && result.verdict !== "passed") {
      return judge({ kind: "check-disagreed", taskId, report: report(taskId) }, threadId, threadId);
    }
    return false;
  }

  function startReady() {
    if (signal?.aborted || failure !== undefined) return;
    const tasks = runtime.view().tasks;
    const status = (id: string) => tasks.find((t) => t.id === id)?.status ?? "pending";
    for (const taskId of readyTasks(plan, status)) {
      if (!active.has(taskId)) startWorker(taskId);
    }
  }

  // A wake from `thread_message`: admitted for a worker whose task is in flight, and watched.
  threads.onWake((spec, start) => {
    const { threadId, taskId } = spec;
    if (spec.kind !== "worker" || !taskId) {
      throw new Error(`${threadId} cannot be woken: only a worker in flight takes a message.`);
    }
    const t = runtime.taskOf(taskId);
    if (
      !active.has(taskId) ||
      ending.has(threadId) ||
      t?.status !== "in-progress" ||
      t.threads.worker !== threadId
    ) {
      throw new Error(`${threadId} is not in flight: its task ${taskId} is not being worked on.`);
    }
    const handle = start();
    watchWorker(taskId, threadId, handle.done);
    return handle;
  });

  return {
    /** Runs the plan to the end: every task done, failed, to check, or blocked behind one that is. */
    async run(workflows?: PayloadOf<"thread.started">["workflows"]): Promise<Folded> {
      const { recorder } = options;
      recorder.emit(root, "thread.started", {
        parentThreadId: null,
        kind: "supervisor",
        ...(workflows && { workflows }),
      });
      try {
        await runtime.start();
        for (startReady(); running.size > 0; startReady()) await Promise.race(running);
      } catch (error) {
        failure ??= error;
        threads.abortAll();
        await Promise.allSettled(running);
      }
      if (failure !== undefined) {
        const error = failure instanceof Error ? failure.message : String(failure);
        recorder.emit(root, "thread.ended", { status: "failed", error });
        throw failure;
      }
      recorder.emit(root, "thread.ended", { status: signal?.aborted ? "cancelled" : "completed" });
      return runtime.view();
    },
  };
}
