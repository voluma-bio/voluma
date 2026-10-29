/**
 * The supervisor: routine wakes are code; the main thread (`main-thread.ts`) is woken at
 * task boundaries and judgment points.
 * It keeps no state of its own. Every step is a function of `fold` of the recorder's
 * events (the stored log, `recorder.ts`), the thread records read from that same log, and
 * which threads are running in this process, and it runs inside the task runtime's
 * `section`. A new process given the stored events steps from where the last one stopped:
 * resume and a first run are the same code.
 *
 * What a step does for a task, by its status (the first applicable):
 * - a thread of the task is running: nothing, wait for it;
 * - the thread in charge of the task was cut off (its latest `thread.started` has no
 *   `thread.ended`: the runtime aborted a claim, or a crash): resume it with a message saying what it was cut off
 *   in. That is no wake and no redo; infrastructure's limit bounds restarts (`cutOffText`);
 * - `pending` or `stale`, every dependency done (or to check with its outputs in): start a worker, named by how many the log
 *   has started for the task (a redo gets a fresh thread, never the old one);
 * - `in-progress`, or `pending` with a worker that ended: a failed worker is a judgment point;
 *   otherwise wake it with a message (it counts as a wake) up to `stuckLimit` wakes, then the
 *   stuck guard marks the task `to-check` (or, with no attempt at all, a judgment point);
 * - `done` or `to-check` without a check thread yet (and not left by a judgment): check-start,
 *   then start the check thread; once its check passed, the task has a boundary wake;
 * - `under-review`: a check that failed is a judgment point; one that ended without a verdict is
 *   woken once; otherwise its result is written,
 *   and a verdict that is not `passed` is a judgment point (`check-disagreed`).
 * A thread that ended `cancelled` was stopped on purpose (a stale dependent, a run failing
 * through `abortAll`; a stop aimed at a cut-off thread writes that end itself) and is never
 * resumed. Only the thread in charge of its task is resumed after a cut-off.
 * A wake (a boundary or a judgment point) is asked of the main thread outside the section,
 * then recorded as a `wake` event with the id `<thread>@<starts>:wake` (the notes it wrote, and at a
 * judgment point its decision) before anything uses it: workers and checks started later get
 * the notes in force, and the next step turns a judgment point's decision into a `judgment`
 * event, `<thread>:judgment`, and applies it. A resume finds these events and asks no one
 * again; a wake the model never answered before a crash is asked again.
 *
 * A thread whose stored History cannot be resumed (`stale`: a deploy changed its prompt, tools
 * or model) is not a failure. A worker's task starts again on a new thread (a code-made `redo`
 * judgment, `redoByCode`); a check is replaced by a new check. A message sent to such a
 * thread is lost. A worker or check that died on a provider error (`providerError`) is treated the
 * same way, up to `maxProviderRedos` times; then the run fails naming the error. An error the host
 * calls fatal (`providerFatal`: a refused key, an empty account) fails the run at once.
 *
 * A thread that throws or is refused before it starts, or an error in a step (a store failure
 * above all), fails the run on purpose: the threads are aborted and the root ends `failed`,
 * because the supervisor must not carry on from a record the store does not hold. The root
 * is the supervisor's own thread: it runs no agent loop and calls no tool.
 */
import { type By, type ModelUsage, WAKE_ERROR_MAX } from "@voluma/contracts/events";
import { checkResult, type Folded, type FoldedTask } from "@voluma/contracts/fold";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import type { ThreadMessageResult } from "@voluma/contracts/thread-message";
import { readyTasks } from "@voluma/workflow";
import { replyFrames } from "./live";
import {
  decisionSchema,
  type MainThread,
  pointOf,
  UnusableReplyError,
  type WakePoint,
} from "./main-thread";
import type { PayloadOf, Recorder } from "./recorder";
import type { PlanTask, TaskRuntime } from "./task-runtime";
import {
  JUDGMENT_SUFFIX,
  type Role,
  startedFor,
  type ThreadLog,
  type ThreadRecord,
  threadLog,
  WAKE_SUFFIX,
} from "./thread-log";
import type { ThreadSpec, Threads } from "./threads";

/** What the caller decides about a worker or check thread; the supervisor adds its identity. */
export type RoleSpec = Pick<ThreadSpec, "prompt" | "model" | "streamFn" | "systemPrompt" | "tools">;

/** A point the main thread decides: a check that disagreed, or a thread that failed. */
type JudgmentPoint = Extract<WakePoint, { kind: "check-disagreed" | "thread-failed" }>;

export interface SupervisorOptions {
  runId: string;
  plan: readonly PlanTask[];
  runtime: TaskRuntime;
  recorder: Recorder;
  threads: Threads;
  main: MainThread;
  /**
   * `notes` are the main thread's notes in force when the thread starts (none yet at the first
   * task). `model` is the one a resumed thread started on, which it must keep.
   */
  worker(
    taskId: string,
    threadId: string,
    notes: string | undefined,
    model: string | undefined,
  ): RoleSpec;
  check(
    taskId: string,
    threadId: string,
    notes: string | undefined,
    model: string | undefined,
  ): RoleSpec;
  /** Wakes of a worker that stopped with its task unfinished before the stuck guard marks it. */
  stuckLimit?: number;
  /** Redos a judgment may order for one task. */
  maxRedos?: number;
  /** Whether a failed thread's error text says the model provider failed (the host knows its texts). */
  providerError?(error: string): boolean;
  /** Whether such an error is fatal for the account (key refused, billing, usage limit): no retry can succeed. */
  providerFatal?(error: string): boolean;
  /**
   * Times a task's worker, and separately its check, is started again after a provider error
   * before the run fails.
   */
  maxProviderRedos?: number;
  /** How long the main thread may take to answer a wake before it counts as failed. */
  wakeTimeoutMs?: number;
  signal?: AbortSignal;
}

/** What `step` found: nothing to do, something done, or a wake to ask, under the key its answer is stored by. */
type Next = "idle" | "acted" | { point: WakePoint; key: string };

/** The supervisor's own thread: the root, and the envelope of a run's first events. */
export const supervisorThreadId = (runId: string) => `${runId}.supervisor`;

const PLAIN_REASON: Record<ClaimEndReason, string> = {
  shutdown: "the runner restarted",
  "self-stop": "the runner lost contact with the server",
  "lease-expired": "the server lost contact with the runner",
};

/** What a cut-off thread is told on resume: the tool it was in, if any, and why, in plain words. */
function cutOffText(after: ClaimEndReason | undefined, tool: string | undefined): string {
  const when = after ? `when ${PLAIN_REASON[after]}` : "when the run was restarted";
  return tool
    ? `Your last call (\`${tool}\`) was cut off ${when}. It may or may not have finished: check its output, then continue.`
    : `You were cut off ${when}; continue.`;
}

const rule = (r: Extract<By, { kind: "rule" }>["rule"]): By => ({ kind: "rule", rule: r });

export function supervisor(options: SupervisorOptions) {
  const { plan, runtime, recorder, threads, main, signal } = options;
  const root = supervisorThreadId(options.runId);
  const stuckLimit = options.stuckLimit ?? 2;
  const maxRedos = options.maxRedos ?? 1;
  const maxProviderRedos = options.maxProviderRedos ?? 2;
  const wakeTimeoutMs = options.wakeTimeoutMs ?? 5 * 60_000;
  let failure: unknown; // the first error that failed the run

  const derive = () => threadLog(recorder.events());

  /** A thread's record; a thread whose `thread.started` the store lacks counts as not ended. */
  const recordOf = (d: ThreadLog, id: string, role: Role, taskId: string): ThreadRecord =>
    d.threads.get(id) ?? {
      id,
      role,
      taskId,
      end: undefined,
      wakes: 0,
      starts: 0,
      model: undefined,
      openCalls: new Map(),
    };

  /**
   * A wake's key: the thread whose end raised it and how many times the log shows it started,
   * so a thread woken again that ends again has a wake of its own.
   */
  const wakeKey = (d: ThreadLog, threadId: string) =>
    `${threadId}@${d.threads.get(threadId)?.starts ?? 0}`;

  /** `<runId>.<taskId>.<role>`, plus `.<n>` for the n-th (ids.ts: run and task ids hold no '.'). */
  const threadId = (taskId: string, role: Role, n: number) =>
    `${options.runId}.${taskId}.${role}${n === 1 ? "" : `.${n}`}`;
  /** An id this process refused as unresumable counts as used, even if its `thread.started` never landed. */
  const nextThreadId = (d: ThreadLog, taskId: string, role: Role) => {
    let n = startedFor(d, taskId, role).length + 1;
    while (threads.stale(threadId(taskId, role, n))) n++;
    return threadId(taskId, role, n);
  };

  /**
   * The task's thread running in this process. The next id counts too: a thread just
   * started has not stored its `thread.started` yet.
   */
  function liveThread(d: ThreadLog, taskId: string) {
    for (const role of ["worker", "check"] as const) {
      const ids = [...startedFor(d, taskId, role).map((r) => r.id), nextThreadId(d, taskId, role)];
      const id = ids.find((x) => threads.running(x));
      if (id) return id;
    }
    return undefined;
  }

  function launch(
    role: Role,
    taskId: string,
    id: string,
    extra: { attemptId?: string; input?: ThreadSpec["input"] } = {},
  ) {
    const { notes, threads: known } = derive();
    const model = known.get(id)?.model;
    threads.start({
      ...(role === "worker"
        ? options.worker(taskId, id, notes, model)
        : options.check(taskId, id, notes, model)),
      threadId: id,
      kind: role,
      parentThreadId: root,
      taskId,
      ...extra,
    });
  }

  /** Starts the thread again with a message: it resumes from its History. A cut-off resume is not a wake (`thread-log.ts`). */
  function wake(r: ThreadRecord, input: NonNullable<ThreadSpec["input"]>, attemptId?: string) {
    launch(r.role, r.taskId, r.id, { ...(attemptId && { attemptId }), input });
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

  /** The reason a recorded judgment applied, rebuilt from the event. */
  function reasonOf(j: PayloadOf<"judgment">, wakeError: string | undefined): string {
    const { fallback } = j.applied;
    if (fallback === "error") {
      return `The judgment could not decide${wakeError ? ` (${wakeError.slice(0, 200)})` : ""}; left for a person.`;
    }
    const { reason } = decisionSchema.parse(j.decision);
    return fallback === "redo-cap"
      ? `${reason} (A redo was ordered, but ${j.taskId} was already redone ${maxRedos} time(s); left for a person.)`
      : reason;
  }

  /**
   * Applies a recorded judgment: a redo is a correction (a revision, a stale mark on each
   * dependent, and last the task's own stale event, which marks it applied); `accept` and
   * `fail` set the task `to-check` or `failed`, first opening an attempt in the failed worker's
   * name if it never touched the task. Every write has a derived id, so a replay writes nothing twice.
   */
  async function apply(
    d: ThreadLog,
    id: string,
    j: PayloadOf<"judgment">,
    t: FoldedTask | undefined,
  ): Promise<Next> {
    const taskId = j.taskId;
    if (!taskId) throw new Error(`judgment ${id} names no task`);
    const eventId = `${root}:${id}${JUDGMENT_SUFFIX}`;
    if (d.ids.has(eventId)) return "idle"; // already applied
    const reason = reasonOf(j, d.wakes.get(wakeKey(d, id))?.error);
    const action = j.applied.action;
    const arm: By = { kind: "judgment", arm: j.arm };
    if (action === "redo") {
      // A task with no attempt, or one this worker never wrote, has nothing of its own to
      // mark: a fresh worker is the redo.
      if (!t || (d.threads.get(id)?.role === "worker" && t.threads.worker !== id)) {
        return startWorker(taskId);
      }
      await recorder.append(
        root,
        "revision.started",
        { reason: "correction", taskId },
        `${eventId}:revision`,
      );
      await runtime.staleDependents(
        root,
        eventId,
        taskId,
        `${taskId} was corrected, so this result may no longer hold.`,
      );
      await runtime.setStatus(root, eventId, taskId, t.attemptId, "stale", reason, arm);
      return "acted";
    }
    let attemptId = t?.attemptId;
    if (!attemptId) {
      attemptId = `${id}:judgment:open`;
      await recorder.append(id, "attempt.opened", { taskId }, attemptId);
    }
    await runtime.setStatus(
      root,
      eventId,
      taskId,
      attemptId,
      action === "fail" ? "failed" : "to-check",
      reason,
      arm,
    );
    return "acted";
  }

  function startWorker(taskId: string): Next {
    const d = derive();
    launch("worker", taskId, nextThreadId(d, taskId, "worker"));
    return "acted";
  }

  /**
   * A worker's task starts again on a fresh thread, as after a `redo` judgment, but decided
   * here with no model call: the thread could not resume after a deploy changed its prompt,
   * tools or model (`code:unresumable-thread`), or it died on a provider error, whose
   * judgment would go to the same failing provider (`code:provider-error`). Recorded as the
   * thread's judgment, so a resume applies it and a restart does not try the thread again.
   */
  async function redoByCode(
    r: ThreadRecord,
    arm: "code:unresumable-thread" | "code:provider-error",
    error: string,
    reason: string,
  ): Promise<Next> {
    await recorder.append(
      root,
      "judgment",
      {
        point: { kind: "thread-failed", input: { error: error.slice(0, WAKE_ERROR_MAX) } },
        arm,
        taskId: r.taskId,
        decision: { action: "redo", reason },
        applied: { action: "redo" },
      },
      `${r.id}${JUDGMENT_SUFFIX}`,
    );
    return "acted";
  }

  /**
   * A worker or check that died on a provider error is started again by code, up to
   * `maxProviderRedos` times per task and role; then the run fails naming the error, rather than
   * ending `completed` with tasks that never ran. Undefined: `error` is not a provider error.
   */
  function providerRetry(d: ThreadLog, r: ThreadRecord, error: string): "redo" | undefined {
    if (!options.providerError?.(error)) return undefined;
    if (options.providerFatal?.(error)) {
      throw new Error(`${r.taskId}: its ${r.role} failed on a model provider error: ${error}`);
    }
    const failures = startedFor(d, r.taskId, r.role).filter(
      (x) => x.end?.status === "failed" && options.providerError?.(x.end.error ?? ""),
    ).length;
    if (failures > maxProviderRedos) {
      throw new Error(
        `${r.taskId}: its ${r.role} failed on a model provider error ${failures} times: ${error}`,
      );
    }
    return "redo";
  }

  /** A worker that is not running and did not finish its task. */
  async function stalled(d: ThreadLog, w: ThreadRecord, t: FoldedTask | undefined): Promise<Next> {
    const j = d.judgments.get(w.id);
    if (j) return apply(d, w.id, j, t);
    const { taskId } = w;
    const unresumable = threads.stale(w.id);
    if (unresumable) {
      return redoByCode(
        w,
        "code:unresumable-thread",
        unresumable,
        `${w.id} could not resume after a change to its prompt, tools or model; ${taskId} starts again on a new thread.`,
      );
    }
    if (w.end?.status === "failed") {
      const error = w.end.error ?? "failed";
      if (providerRetry(d, w, error)) {
        return redoByCode(
          w,
          "code:provider-error",
          error,
          `${w.id} failed on a model provider error (${error.slice(0, 200)}); ${taskId} starts again on a new thread.`,
        );
      }
      return judgmentFor(d, { kind: "thread-failed", taskId, error, report: report(taskId) }, w.id);
    }
    if (w.wakes < stuckLimit) {
      const text = `You stopped, but ${taskId} is not finished. Report its outputs and set its status with checklist (done, to-check or failed).`;
      wake(w, { text, sender: { kind: "runtime" } });
      return "acted";
    }
    if (!t || t.threads.worker !== w.id) {
      // It never wrote to the attempt now current; marking that attempt is not its to do.
      const error = "the worker ended without touching its task";
      return judgmentFor(d, { kind: "thread-failed", taskId, error, report: report(taskId) }, w.id);
    }
    await runtime.setStatus(
      w.id,
      `${w.id}:stuck:${taskId}`,
      taskId,
      t.attemptId,
      "to-check",
      "The worker stopped before finishing this task.",
      rule("stuck"),
    );
    return "acted";
  }

  /** The result of a check thread that is over: the task takes `checkResult` of its fold. */
  async function finishCheck(t: FoldedTask, c: ThreadRecord): Promise<Next> {
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
    await runtime.setStatus(
      c.id,
      `${c.id}:result`,
      t.id,
      t.attemptId,
      status,
      reason,
      rule("check-result"),
    );
    return "acted";
  }

  async function startCheck(d: ThreadLog, t: FoldedTask): Promise<Next> {
    const id = nextThreadId(d, t.id, "check");
    await runtime.setStatus(
      id,
      `${id}:start`,
      t.id,
      t.attemptId,
      "under-review",
      "A second agent is checking this task.",
      rule("check-start"),
    );
    launch("check", t.id, id, { attemptId: t.attemptId });
    return "acted";
  }

  async function stepTask(
    f: Folded,
    d: ThreadLog,
    taskId: string,
    ready: Set<string>,
  ): Promise<Next> {
    if (liveThread(d, taskId)) return "idle";
    const t = f.tasks.find((x) => x.id === taskId);
    // A cut-off thread goes on where it was. A thread this process started is not one: it ended
    // here, its end not stored yet, or it was refused as unresumable (handled below).
    const inCharge = (r: ThreadRecord) =>
      r.role === "worker"
        ? !t?.threads.worker || t.threads.worker === r.id
        : t?.status === "under-review" && t.threads.check === r.id;
    const cutOff = [...startedFor(d, taskId, "worker"), ...startedFor(d, taskId, "check")].find(
      (r) => !r.end && !threads.started(r.id) && inCharge(r),
    );
    if (cutOff) {
      const tool = [...cutOff.openCalls.values()].at(-1);
      wake(
        cutOff,
        { text: cutOffText(d.after, tool), sender: { kind: "runtime" } },
        cutOff.role === "check" ? t?.attemptId : undefined,
      );
      return "acted";
    }
    // The latest started worker is in charge of the task. One that is not running and has
    // not written to the current attempt (none yet, or a stale one an earlier worker wrote),
    // or left it in progress, stalls: wake it, then a judgment point.
    const worker = startedFor(d, taskId, "worker").at(-1);
    // A worker that was stopped on purpose (`cancelled`) is not woken; its task starts again.
    const stopped = worker?.end?.status === "cancelled";
    if (
      worker &&
      !stopped &&
      (!t || t.status === "in-progress" || (t.status === "stale" && t.threads.worker !== worker.id))
    ) {
      return stalled(d, worker, t);
    }
    if (stopped && t?.status === "in-progress") return startWorker(taskId);
    if (!t) return ready.has(taskId) ? startWorker(taskId) : "idle";
    const workerId = worker?.id ?? "";
    switch (t.status) {
      case "stale":
        return ready.has(taskId) ? startWorker(taskId) : "idle";
      case "done":
      case "to-check": {
        const checkId = t.threads.check;
        // A judgment left the task for a person: no check follows.
        if (!checkId) return d.judgments.has(workerId) ? "idle" : startCheck(d, t);
        const c = recordOf(d, checkId, "check", taskId);
        if (t.status === "to-check" && t.checker?.verdict !== "passed" && !d.judgments.has(c.id)) {
          return judgmentFor(d, { kind: "check-disagreed", taskId, report: report(taskId) }, c.id);
        }
        const j = d.judgments.get(c.id);
        if (j) return apply(d, c.id, j, t);
        // The check passed: the task's boundary.
        const key = wakeKey(d, c.id);
        return d.wakes.has(key)
          ? "idle"
          : { point: { kind: "task-checked", taskId, report: report(taskId) }, key };
      }
      case "under-review": {
        // The task went under review but its check thread has no stored start: start it.
        if (!t.threads.check) {
          launch("check", taskId, nextThreadId(d, taskId, "check"), { attemptId: t.attemptId });
          return "acted";
        }
        const c = recordOf(d, t.threads.check, "check", taskId);
        const j = d.judgments.get(c.id);
        if (j) return apply(d, c.id, j, t);
        // A check that cannot resume is checked again by a new thread; the worker's result stands.
        if (threads.stale(c.id)) {
          launch("check", taskId, nextThreadId(d, taskId, "check"), { attemptId: t.attemptId });
          return "acted";
        }
        if (c.end?.status === "failed") {
          const error = c.end.error ?? "failed";
          // The worker's result stands; a new check replaces the one the provider cut short.
          if (providerRetry(d, c, error)) {
            launch("check", taskId, nextThreadId(d, taskId, "check"), { attemptId: t.attemptId });
            return "acted";
          }
          return judgmentFor(
            d,
            { kind: "thread-failed", taskId, error, report: report(taskId) },
            c.id,
          );
        }
        // A check that stopped without a verdict (it wrote "Passed" in the text only) is
        // woken once, as a worker is, before its task is left with no verdict.
        if (c.end?.status === "cancelled") {
          launch("check", taskId, nextThreadId(d, taskId, "check"), { attemptId: t.attemptId });
          return "acted";
        }
        if (t.checker?.verdict === undefined && c.wakes < 1) {
          const text = `You stopped before giving a verdict. Write a checkpoint on ${taskId} with verdict "passed" if you agree or "needs-review" if you do not or cannot tell, and one plain line of why.`;
          wake(c, { text, sender: { kind: "runtime" } }, t.attemptId);
          return "acted";
        }
        return finishCheck(t, c);
      }
      default:
        return "idle"; // failed: left for a person
    }
  }

  /** One decision, inside the section: the first task with something to do. */
  async function step(): Promise<Next> {
    const f = runtime.view();
    const d = derive();
    const ready = new Set(readyTasks(plan, (id) => f.tasks.find((t) => t.id === id)));
    for (const { id } of plan) {
      const next = await stepTask(f, d, id, ready);
      if (next !== "idle") return next;
    }
    return "idle";
  }

  /**
   * A judgment point: ask the main thread if it has not been, else record what was applied
   * (the point, the model's decision and the action taken, and on a fallback why) as
   * `<threadId>:judgment`. The next step applies it, as it would after a crash.
   */
  async function judgmentFor(d: ThreadLog, point: JudgmentPoint, threadId: string): Promise<Next> {
    const key = wakeKey(d, threadId);
    const wake = d.wakes.get(key);
    if (!wake) return { point, key };
    const { taskId } = point;
    let action: "accept" | "redo" | "fail" = "accept";
    let fallback: "error" | "redo-cap" | undefined;
    if (!wake.decision) {
      // The main thread's own call died on the provider: the outage is what ends the run, not a
      // task left unjudged with its dependents never started.
      if (wake.error && options.providerError?.(wake.error)) {
        throw new Error(`the main thread could not judge ${taskId}: ${wake.error}`);
      }
      // A person can still read the task; a main thread that failed must not stall the run.
      fallback = "error";
    } else if (wake.decision.action === "redo" && redosOf(d, taskId) >= maxRedos) {
      fallback = "redo-cap";
    } else {
      action = wake.decision.action;
    }
    const { kind, input } = pointOf(point);
    await recorder.append(
      root,
      "judgment",
      {
        point: { kind, input },
        arm: `main:${wake.model}`,
        taskId,
        ...(wake.decision && { decision: wake.decision }),
        applied: { action, ...(fallback && { fallback }) },
      },
      `${threadId}${JUDGMENT_SUFFIX}`,
    );
    return "acted";
  }

  /**
   * Asks the main thread one wake outside the section, bounded: it counts as failed if it
   * errors or runs past the limit, and a stop is no answer. Its answer is stored as
   * `<thread>@<starts>:wake` before anything uses it.
   */
  async function wakeMain({ point, key }: { point: WakePoint; key: string }) {
    const limit = AbortSignal.any([
      AbortSignal.timeout(wakeTimeoutMs),
      ...(signal ? [signal] : []),
    ]);
    const expired = new Promise<never>((_, reject) =>
      limit.addEventListener("abort", () => reject(new Error("timed out or cancelled")), {
        once: true,
      }),
    );
    const wakeId = `${key}${WAKE_SUFFIX}`;
    const past = [...derive().wakes.values()];
    let answer: Awaited<ReturnType<MainThread["ask"]>> | { error: string; usage?: ModelUsage };
    try {
      answer = await Promise.race([
        main.ask(point, past, limit, replyFrames(root, wakeId, recorder.live)),
        expired,
      ]);
    } catch (error) {
      answer = {
        error: error instanceof Error ? error.message : String(error),
        usage: error instanceof UnusableReplyError ? error.usage : undefined,
      };
    }
    if (signal?.aborted) return;
    await runtime.section(async () => {
      if (derive().wakes.has(key)) return;
      await recorder.append(
        root,
        "wake",
        {
          point: pointOf(point),
          model: main.model,
          ...("error" in answer
            ? {
                error: answer.error.slice(0, WAKE_ERROR_MAX),
                ...(answer.usage && { usage: answer.usage }),
              }
            : {
                ...(answer.usage && { usage: answer.usage }),
                ...(answer.note !== undefined && { note: answer.note }),
                ...(answer.decision && { decision: answer.decision }),
              }),
        },
        wakeId,
      );
    });
  }

  const redosOf = (d: ThreadLog, taskId: string) =>
    // A restart for an unresumable thread (`code:` arms) is not the main thread's to count.
    [...d.judgments.values()].filter(
      (j) => j.taskId === taskId && j.applied.action === "redo" && !j.arm.startsWith("code:"),
    ).length;

  const fail = (error: unknown) => {
    failure ??= error;
    threads.abortAll();
  };

  /** Whether the run has failed: a step error, a thread refused or thrown, an event given up on. */
  function failed(): boolean {
    const cause = threads.failure() ?? recorder.failure();
    if (cause !== undefined) fail(cause);
    return failure !== undefined;
  }

  return {
    /**
     * Runs the plan to the end: every task done, failed, to check, or blocked behind one that is.
     * The caller has emitted the root's `thread.started` (`superviseRun`).
     */
    async run(): Promise<Folded> {
      try {
        // A stop during the run-start wake leaves no `revision.started`, so a resume asks again.
        if (!signal?.aborted) await runtime.start();
        // `quiet`: the last step found nothing to do with no thread running.
        let quiet = false;
        while (!signal?.aborted && !failed()) {
          const next = await runtime.section(step);
          const wasQuiet = quiet;
          quiet = next === "idle" && !threads.active();
          if (next === "acted") continue;
          if (next !== "idle") {
            await wakeMain(next);
          } else if (threads.active()) {
            await threads.anyIdle();
            await recorder.flush(); // the thread's end is stored before the next step reads it
          } else {
            // Nothing is running: step once more after the log is stored, in case a thread
            // ended between the step and this check.
            await recorder.flush();
            if (wasQuiet) break;
          }
        }
      } catch (error) {
        fail(error);
      }
      while (threads.active()) await threads.anyIdle();
      await recorder.flush();
      failed();
      if (failure !== undefined) {
        const error = failure instanceof Error ? failure.message : String(failure);
        if (!signal?.aborted) recorder.emit(root, "thread.ended", { status: "failed", error });
        throw failure;
      }
      // A runtime abort writes no end, like a crash: the next claim resumes the root as well.
      if (!signal?.aborted) recorder.emit(root, "thread.ended", { status: "completed" });
      return runtime.view();
    },

    /** `thread_message`: steer a running thread, or wake an idle one if its task is waiting on it. */
    async message(from: string, to: string, text: string): Promise<ThreadMessageResult> {
      if (to === from) throw new Error("a thread cannot message itself");
      const sender = { kind: "thread", threadId: from } as const;
      if (threads.send(to, text, sender)) return { delivery: "steered" };
      // `send` refuses once the thread has ended, a moment before it stops running.
      await threads.idle(to);
      await recorder.flush();
      await runtime.section(async () => {
        const d = derive();
        const r = d.threads.get(to);
        if (!r) throw new Error(`no worker or check thread ${to} in this run`);
        const t = runtime.taskOf(r.taskId);
        const waiting =
          r.role === "worker"
            ? t?.status === "in-progress" && t.threads.worker === to
            : t?.status === "under-review" && t.threads.check === to;
        if (!waiting || liveThread(d, r.taskId)) {
          throw new Error(`${to} is not waiting: its task ${r.taskId} is not being worked on.`);
        }
        wake(r, { text, sender }, r.role === "check" ? t?.attemptId : undefined);
      });
      return { delivery: "queued" };
    },
  };
}
