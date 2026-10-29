/**
 * The run loop: the code that keeps a run going while the main agent decides what to do.
 * It starts the main agent once and then, one step at a time inside the task runtime's
 * `section`, does the first applicable of: resume a thread a crash cut off, start the check
 * of a submitted task, write a finished check's result, enforce the check deadline, deliver
 * what happened to the main agent, and end a run whose main agent stops moving. It keeps no
 * state of its own: every step is a function of the stored events (`thread-log.ts`, `fold`)
 * plus which threads run in this process, so a resumed run and a first run are the same code.
 *
 * Workers are started by the main agent's `start_worker`, not here. The main agent hears
 * about the run only through delivery messages that resume it (`main-view.ts`); a delivery's
 * `covers` is the last event it accounted for, so notices after it are still undelivered.
 * The run ends when the root thread has a completed `thread.ended` (`finish_run`, or the
 * liveness rule); then every thread without an end is stopped.
 *
 * A thread that throws or is refused before it starts, a store failure, a fatal provider
 * error, or a main agent failing on the provider too often fails the run on purpose: the
 * threads are aborted and the root ends `failed`, because the loop must not carry on from a
 * record the store does not hold. A runtime abort writes no end, like a crash.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { By, RunEvent } from "@voluma/contracts/events";
import { checkResult, type Folded, type FoldedTask, fold } from "@voluma/contracts/fold";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import type { UserSender } from "./adapters/pi/start-thread";
import type { RunLayout, ThreadLayout } from "./layout";
import { agentsList, changedTasks, noticeLine, stateBlock, taskRows, taskTable } from "./main-view";
import type { Recorder } from "./recorder";
import type { PlanTask, TaskRuntime } from "./task-runtime";
import { mainThreadId, threadId } from "./thread-id";
import {
  activeMs,
  openAsk,
  type Role,
  runEnded,
  startedFor,
  type ThreadLog,
  type ThreadRecord,
  type ThreadState,
  threadLog,
  threadState,
} from "./thread-log";
import type { ThreadSpec, Threads } from "./threads";
import { interruptedResult } from "./tools/effects";
import type { Agents } from "./tools/main-tools";
import type { Tool } from "./tools/tool";

/** What a host decides about a role's threads; the loop adds identity and the tools. */
export interface RoleSetup {
  systemPrompt: string;
  model: Model<Api>;
  streamFn: StreamFn;
  /** The tool names the role's file grants (`TOOL_NAMES`). */
  tools: readonly string[];
}

/**
 * A role's setup for one thread. `recorded` is the model (`provider/id`) a resumed thread
 * started on, which it must keep.
 */
export type RoleOf = (thread: ThreadLayout, recorded: string | undefined) => RoleSetup;

/** The first message of each kind of thread, which the host writes. */
export interface Briefs {
  /** The main agent's first message: the plan, the deliverable, the researcher's notes. */
  main(view: Folded): string;
  /** `main.<n>`'s first message, when the thread before it cannot go on; `state` is the agents list and task table. */
  mainRestart(view: Folded, state: string): string;
  /** A worker's first message: the task as planned and the main agent's `brief`. */
  worker(task: PlanTask, brief: string): string;
  /** A check thread's first message: the task as planned and its reported outputs. */
  check(task: PlanTask, state: FoldedTask): string;
}

export interface LoopConfig {
  /** `needs-review` rounds a task gets before it is left to-check. */
  maxFixRounds: number;
  /** A check's active time before it is stopped. */
  checkTimeoutMs: number;
  /** Deliveries with no notice in a row before code ends the run. */
  stuckLimit: number;
  /** Times a thread is started again after a provider error before the run fails. */
  maxProviderRedos: number;
}

export const LOOP_DEFAULTS: LoopConfig = {
  maxFixRounds: 2,
  checkTimeoutMs: 20 * 60_000,
  stuckLimit: 2,
  maxProviderRedos: 2,
};

export interface RunLoopOptions {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  runtime: TaskRuntime;
  threads: Threads;
  layout: RunLayout;
  roles: { main: RoleOf; worker: RoleOf; check: RoleOf };
  briefs: Briefs;
  config?: Partial<LoopConfig>;
  /** Builds the tools a thread's role names; the main agent's tools act through `agents`. */
  tools(thread: ThreadLayout, names: readonly string[], agents: Agents): Tool[];
  /** Whether a failed thread's error text says the model provider failed (the host knows its texts). */
  providerError?(error: string): boolean;
  /** Whether such an error means no retry can succeed: the run then fails at once. */
  providerFatal?(error: string): boolean;
  signal?: AbortSignal;
}

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

/** How long the main agent gets to end its turn after the run ended. */
const MAIN_GRACE_MS = 15_000;

const rule = (r: Extract<By, { kind: "rule" }>["rule"]): By => ({ kind: "rule", rule: r });
const RUNTIME: UserSender = { kind: "runtime" };

/** What a step found: something done, nothing to do (wake after `wakeInMs` at the latest), or the run is over. */
type Step = "acted" | "done" | { wakeInMs?: number };

export async function runLoop(o: RunLoopOptions): Promise<Folded> {
  const { runId, rootThreadId: root, recorder, runtime, threads, signal } = o;
  const config = { ...LOOP_DEFAULTS, ...o.config };
  const providerError = (e: string) => o.providerError?.(e) === true;
  let failure: unknown; // the first error that failed the run
  /** Threads whose refusal as unresumable the loop has dealt with. */
  const dealtWith = new Set<string>();

  // A change of the run (a thread settled, a main tool wrote) wakes the loop; a change that
  // lands during a step is seen by the next one because the loop compares versions.
  let version = 0;
  let waiters: (() => void)[] = [];
  const nudge = () => {
    version++;
    for (const wake of waiters.splice(0)) wake();
  };
  async function sleep(seen: number, ms: number | undefined) {
    if (version !== seen || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        waiters = waiters.filter((w) => w !== done);
        resolve();
      };
      const timer = ms === undefined ? undefined : setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      waiters.push(done);
    });
  }

  const derive = () => threadLog(recorder.events());
  const stateOf = (r: ThreadRecord | undefined): ThreadState | undefined =>
    threadState(r, threads.running(r?.id ?? ""));

  // ---- starting and resuming threads

  const planTask = (view: Folded, taskId: string): PlanTask => {
    const found = view.plan.tasks.find((t) => t.id === taskId);
    if (!found) throw new Error(`${taskId} is not a task of the plan`);
    return found;
  };

  /** The brief the main agent gave a worker, read back from its `start_worker` call. */
  function workerBrief(events: readonly RunEvent[], r: ThreadRecord): string {
    const spawnedBy = events.find(
      (e) => e.type === "thread.started" && e.threadId === r.id && e.payload.spawnedBy,
    );
    const toolCallId =
      spawnedBy?.type === "thread.started" ? spawnedBy.payload.spawnedBy : undefined;
    const call = events.find((e) => e.type === "tool.call" && e.payload.toolCallId === toolCallId);
    const input =
      call?.type === "tool.call" ? (call.payload.input as { brief?: string }) : undefined;
    return input?.brief ?? "";
  }

  function mainFirstMessage(view: Folded, n: number, d: ThreadLog) {
    if (n === 1) return { prompt: o.briefs.main(view) };
    const events = recorder.events();
    return {
      prompt: o.briefs.mainRestart(view, stateBlock(d, events, view, stateOf)),
      promptCovers: events.at(-1)?.id,
    };
  }

  /** The start options for a thread; `prompt` is its first message, which a resumed thread uses only if it never stored one. */
  function specFor(r: { id: string; kind: "main" } | { id: string; kind: Role; taskId: string }) {
    const d = derive();
    const view = runtime.view();
    const taskId = r.kind === "main" ? undefined : r.taskId;
    const thread = o.layout.forThread(r.id, taskId ? (p) => runtime.cites(taskId, p) : undefined);
    const role = o.roles[r.kind](thread, d.threads.get(r.id)?.model);
    const common = {
      threadId: r.id,
      systemPrompt: role.systemPrompt,
      model: role.model,
      streamFn: role.streamFn,
      tools: o.tools(thread, role.tools, agents),
      interrupted: (tool: string, toolCallId: string) =>
        interruptedResult(recorder.events(), r.id, tool, toolCallId),
    };
    if (r.kind === "main") {
      const n = Number(/\.main(?:\.(\d+))?$/.exec(r.id)?.[1] ?? 1);
      return {
        ...common,
        kind: "main" as const,
        parentThreadId: root,
        ...mainFirstMessage(view, n, d),
      } satisfies ThreadSpec;
    }
    const task = planTask(view, r.taskId);
    const record = d.threads.get(r.id);
    if (r.kind === "worker") {
      return {
        ...common,
        kind: "worker" as const,
        taskId: r.taskId,
        parentThreadId: d.main ?? root,
        prompt: o.briefs.worker(task, record ? workerBrief(recorder.events(), record) : ""),
      } satisfies ThreadSpec;
    }
    const folded = runtime.taskOf(r.taskId);
    if (!folded) throw new Error(`${r.taskId} has no folded task to check`);
    return {
      ...common,
      kind: "check" as const,
      taskId: r.taskId,
      parentThreadId: root,
      ...(folded.attemptId && { attemptId: folded.attemptId }),
      prompt: o.briefs.check(task, folded),
    } satisfies ThreadSpec;
  }

  /** Runs the thread; the loop steps again when it settles and its end is stored. */
  function begin(spec: ThreadSpec) {
    threads.start(spec);
    void threads
      .idle(spec.threadId)
      .then(() => recorder.flush())
      .then(nudge, nudge);
  }

  /**
   * Starts a thread that has no history: its `thread.started` is stored first (id given), so
   * the log counts it at once and its id is never reused; the thread's own emit is a no-op.
   */
  async function startNew(spec: ThreadSpec, startedEventId: string, spawnedBy?: string) {
    await recorder.append(
      spec.threadId,
      "thread.started",
      {
        parentThreadId: spec.parentThreadId ?? null,
        kind: spec.kind,
        ...(spec.taskId && { task: spec.taskId }),
        ...(spec.attemptId && { attemptId: spec.attemptId }),
        ...(spawnedBy && { spawnedBy }),
        model: `${spec.model.provider}/${spec.model.id}`,
      },
      startedEventId,
    );
    begin({ ...spec, startedEventId, ...(spawnedBy && { spawnedBy }) });
  }

  /** Resumes a thread that is not running, from its History, with a message. */
  function resume(r: ThreadRecord, text: string, sender: UserSender) {
    const spec =
      r.role === "main"
        ? specFor({ id: r.id, kind: "main" })
        : specFor({ id: r.id, kind: r.role, taskId: r.taskId });
    begin({ ...spec, input: { text, sender } });
  }

  /** The next id of a task's thread; an id this process found unresumable is used up. */
  function nextId(d: ThreadLog, taskId: string, role: Role) {
    let n = startedFor(d, taskId, role).length + 1;
    while (threads.stale(threadId(runId, taskId, role, n))) n++;
    return threadId(runId, taskId, role, n);
  }

  function nextMainId(d: ThreadLog) {
    let n = [...d.threads.values()].filter((r) => r.role === "main").length + 1;
    while (threads.stale(mainThreadId(runId, n))) n++;
    return mainThreadId(runId, n);
  }

  const startMain = (d: ThreadLog) => {
    const id = nextMainId(d);
    return startNew(specFor({ id, kind: "main" }), `${id}:started`);
  };

  const startCheck = (d: ThreadLog, taskId: string) => {
    const id = nextId(d, taskId, "check");
    return startNew(specFor({ id, kind: "check", taskId }), `${id}:started`);
  };

  const agents: Agents = {
    state: (d, id) => threadState(d.threads.get(id), threads.running(id)),
    nextWorkerId: (taskId) => nextId(derive(), taskId, "worker"),
    startWorker: async ({
      threadId: id,
      taskId,
      brief,
      mainThreadId: main,
      spawnedBy,
      startedEventId,
    }) => {
      const spec = specFor({ id, kind: "worker", taskId });
      const task = planTask(runtime.view(), taskId);
      await startNew(
        { ...spec, parentThreadId: main, prompt: o.briefs.worker(task, brief) },
        startedEventId,
        spawnedBy,
      );
    },
    steer: (id, text, sender) => threads.send(id, text, sender),
    settled: (id) => threads.idle(id),
    resume: (id, text, sender) => {
      const r = derive().threads.get(id);
      if (!r) throw new Error(`no thread ${id} to resume`);
      resume(r, text, sender);
    },
    changed: nudge,
  };

  // ---- steps

  /** Whether the main agent is still in charge of nothing but waiting: no worker or checker runs. */
  const anyRunning = (d: ThreadLog) =>
    [...d.threads.values()].some((r) => r.role !== "main" && threads.running(r.id));

  /** The thread a crash cut off is still the one in charge of its work. */
  function inCharge(d: ThreadLog, r: ThreadRecord): boolean {
    if (r.role === "main") return d.main === r.id;
    const t = runtime.taskOf(r.taskId);
    if (r.role === "check")
      return t?.status === "under-review" && t.threads.check === r.id && !t.checker;
    const latest = startedFor(d, r.taskId, "worker")
      .filter((w) => w.end?.status !== "cancelled")
      .at(-1);
    return (
      latest?.id === r.id &&
      !t?.skipped &&
      (t?.status === undefined || t.status === "pending" || t.status === "in-progress")
    );
  }

  /** Threads this process was refused as unresumable: the main agent starts over, a check is made again, a worker is stopped. */
  async function unresumable(d: ThreadLog): Promise<boolean> {
    for (const r of d.threads.values()) {
      if (!threads.stale(r.id) || dealtWith.has(r.id)) continue;
      dealtWith.add(r.id);
      if (r.role === "main") {
        if (d.main === r.id) {
          await startMain(d);
          return true;
        }
      } else {
        await runtime.stop(r.id, `${r.id}:unresumable`);
        if (r.role === "check" && runtime.taskOf(r.taskId)?.threads.check === r.id) {
          await startCheck(derive(), r.taskId);
        }
        return true;
      }
    }
    return false;
  }

  function resumeCutOff(d: ThreadLog): boolean {
    for (const r of d.threads.values()) {
      if (stateOf(r) !== "cut-off" || threads.stale(r.id) || !inCharge(d, r)) continue;
      const tool = [...r.openCalls.values()].at(-1);
      resume(r, cutOffText(d.after, tool), RUNTIME);
      return true;
    }
    return false;
  }

  /** A task `under-review` whose attempt has no check thread: start one. */
  async function startChecks(d: ThreadLog, view: Folded): Promise<boolean> {
    for (const t of view.tasks) {
      if (t.status === "under-review" && t.attemptId && !t.threads.check) {
        await startCheck(d, t.id);
        return true;
      }
    }
    return false;
  }

  const checkReason = (t: FoldedTask, status: "done" | "to-check") => {
    if (status === "done") return "The second agent checked this task and agrees.";
    if (t.checker?.verdict === undefined) return "The check ended without a verdict.";
    if (t.checker.verdict === "needs-review")
      return "The second agent found problems with this task.";
    return t.missingRequired.length > 0
      ? `Required outputs are missing: ${t.missingRequired.join(", ")}.`
      : "The check passed, but items are still open for a person.";
  };

  /** Provider failures among a task's checks (the current one included). */
  const checkFailures = (d: ThreadLog, taskId: string) =>
    startedFor(d, taskId, "check").filter(
      (c) => c.end?.status === "failed" && providerError(c.end.error ?? ""),
    ).length;

  /** The result of a check: the task takes `checkResult`, or `to-check` when there was no verdict. */
  async function writeResult(
    d: ThreadLog,
    t: FoldedTask,
    c: ThreadRecord,
    ruleName: "check-result" | "check-limit" | "fix-limit",
    reason?: string,
  ) {
    if (!t.attemptId) throw new Error(`${t.id} has no attempt to give a result`);
    const status = ruleName === "check-limit" ? "to-check" : checkResult(t);
    const limit =
      ruleName === "check-result" &&
      t.checker?.verdict === "needs-review" &&
      (d.fixRounds.get(t.id) ?? 0) + 1 >= config.maxFixRounds;
    const used = limit ? "fix-limit" : ruleName;
    await runtime.setStatus(
      c.id,
      `${c.id}:result`,
      t.id,
      t.attemptId,
      status,
      reason ??
        (used === "fix-limit"
          ? `The second agent still found problems after ${config.maxFixRounds} rounds of fixes; this task is left for a person.`
          : checkReason(t, status)),
      rule(used),
    );
  }

  /** Check results and deadlines, one action per call. Also reports the next deadline. */
  async function checks(d: ThreadLog, view: Folded, deadline: { next?: number }): Promise<boolean> {
    for (const t of view.tasks) {
      if (t.status !== "under-review" || !t.threads.check) continue;
      const c = d.threads.get(t.threads.check);
      if (!c || c.role !== "check") continue;
      const state = stateOf(c);
      const verdict = t.checker?.verdict;
      const waiting = openAsk(c) !== undefined;
      if (state === "stopped" && !verdict) {
        await writeResult(
          d,
          t,
          c,
          "check-result",
          "The check was stopped before it gave a verdict.",
        );
        return true;
      }
      if (state === "running" || waiting || (state === "cut-off" && !verdict)) {
        const left = config.checkTimeoutMs - activeMs(c, Date.now(), state === "running");
        if (left <= 0) {
          await runtime.stop(c.id, `${c.id}:limit`);
          await writeResult(d, t, c, "check-limit", "The check ran past its time limit.");
          return true;
        }
        deadline.next = Math.min(deadline.next ?? left, left);
        continue;
      }
      // Idle, or stopped/cut off with a verdict: the check is over.
      const last = c.asks.at(-1);
      if (!verdict && last?.answer && (c.answeredAt ?? -1) > c.startedAt && state === "idle") {
        const files = last.answer.files.map((f) => `${f.root}:${f.path}`).join(", ");
        resume(
          c,
          `The main agent answers: ${last.answer.text}${files ? `\nFiles for you: ${files} (root "scratch" is /scratch/<path>, "outputs" is /outputs/${t.id}/<path>).` : ""}`,
          { kind: "thread", threadId: d.main ?? root },
        );
        return true;
      }
      if (verdict) {
        await writeResult(d, t, c, "check-result");
        return true;
      }
      const error = c.end?.error ?? "";
      if (c.end?.status === "failed" && providerError(error)) {
        if (o.providerFatal?.(error))
          throw new Error(`${t.id}: its check failed on a model provider error: ${error}`);
        if (checkFailures(d, t.id) <= config.maxProviderRedos) {
          await startCheck(d, t.id);
          return true;
        }
      }
      if (c.end?.status === "completed" && c.wakes < 1) {
        resume(
          c,
          `You stopped before giving a verdict. Write a checkpoint on ${t.id} with verdict "passed" if you agree or "needs-review" if you do not or cannot tell, and one plain line of why.`,
          RUNTIME,
        );
        return true;
      }
      await writeResult(d, t, c, "check-result");
      return true;
    }
    return false;
  }

  /** Throws when a thread this process ran failed on an error no retry can fix. */
  function checkFatal(d: ThreadLog) {
    for (const r of d.threads.values()) {
      const error = r.end?.status === "failed" ? (r.end.error ?? "") : undefined;
      if (
        error !== undefined &&
        threads.started(r.id) &&
        providerError(error) &&
        o.providerFatal?.(error)
      ) {
        throw new Error(`${r.id} failed on a model provider error: ${error}`);
      }
    }
  }

  /** The delivery message: the notices, the live agents and the tasks whose row changed. */
  function delivery(d: ThreadLog) {
    const events = recorder.events();
    const view = runtime.view();
    const covers = events.at(-1)?.id;
    const cut = d.cursor ? events.findIndex((e) => e.id === d.cursor) + 1 : 0;
    const rows = changedTasks(fold(events.slice(0, cut)), view);
    const text = [
      d.undelivered.map(noticeLine).join("\n"),
      `Agents:\n${agentsList(d, events, stateOf)}`,
      rows.length > 0 ? `Tasks that changed:\n${taskTable(rows)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { text, covers };
  }

  /** Main is idle: tell it what happened, restart it, or end a run it stopped moving. */
  async function main(d: ThreadLog, view: Folded): Promise<boolean> {
    const m = d.main ? d.threads.get(d.main) : undefined;
    if (!m || stateOf(m) !== "idle") return false;
    const events = recorder.events();
    if (m.end?.status === "failed" && providerError(m.end.error ?? "")) {
      const error = m.end.error ?? "";
      if (o.providerFatal?.(error))
        throw new Error(`the main agent failed on a model provider error: ${error}`);
      const failures = [...d.threads.values()].filter(
        (r) => r.role === "main" && r.end?.status === "failed" && providerError(r.end.error ?? ""),
      ).length;
      if (failures > config.maxProviderRedos) {
        throw new Error(
          `the main agent failed on a model provider error ${failures} times: ${error}`,
        );
      }
      await startMain(d);
      return true;
    }
    if (d.undelivered.length > 0) {
      const { text, covers } = delivery(d);
      resume(m, text, { kind: "runtime", ...(covers && { covers }) });
      return true;
    }
    if (anyRunning(d)) return false;
    const covers = events.at(-1)?.id;
    if (d.emptyDeliveries < config.stuckLimit) {
      resume(
        m,
        `Nothing is running and the run is not finished: start the next workers, or finish the run.\n\n${stateBlock(d, events, view, stateOf)}`,
        { kind: "runtime", ...(covers && { covers }) },
      );
      return true;
    }
    await endStuckRun(view);
    return true;
  }

  /** The main agent stopped moving: skip every unfinished task and end the run. */
  async function endStuckRun(view: Folded) {
    const unfinished = taskRows(view).filter(
      (t) => !t.skipped && t.status !== "done" && t.status !== "to-check",
    );
    if (unfinished.length > 0) {
      await recorder.append(
        root,
        "plan.changed",
        {
          reason: "The main agent stopped before every task was done, so the run ended.",
          skip: unfinished.map((t) => ({
            taskId: t.id,
            reason: "The run stopped before this task was done",
          })),
        },
        `${root}:liveness:plan`,
      );
    }
    await recorder.append(
      root,
      "thread.ended",
      {
        status: "completed",
        summary: unfinished.length
          ? `The run stopped before every task was done: ${unfinished.map((t) => t.id).join(", ")} ${unfinished.length === 1 ? "was" : "were"} skipped.`
          : "The run stopped with every task finished.",
      },
      `${root}:liveness:end`,
    );
  }

  /** One decision, inside the section: the first thing that applies. */
  async function step(): Promise<Step> {
    await recorder.flush(); // a thread's end is stored before it is read
    if (runEnded(recorder.events(), root)) return "done";
    const d = derive();
    const view = runtime.view();
    checkFatal(d);
    if (!d.main) {
      await startMain(d);
      return "acted";
    }
    if (await unresumable(d)) return "acted";
    if (resumeCutOff(d)) return "acted";
    if (await startChecks(d, view)) return "acted";
    const deadline: { next?: number } = {};
    if (await checks(d, view, deadline)) return "acted";
    if (await main(d, view)) return "acted";
    return { wakeInMs: deadline.next };
  }

  // ---- the run

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

  /**
   * Stores the end of every thread that has none (append-first), then aborts the running ones.
   * The main agent is left to finish its turn first (`finish_run` ended it), so a finished run
   * does not show it as cancelled; it is stopped if it takes more than `MAIN_GRACE_MS`.
   */
  async function stopAll() {
    const stopThreads = (spare?: string) =>
      runtime.section(async () => {
        for (const r of derive().threads.values()) {
          if (r.id !== spare && (!r.end || threads.running(r.id))) {
            await runtime.stop(r.id, `${root}:end:${r.id}`);
          }
        }
      });
    const main = derive().main;
    await stopThreads(main && threads.running(main) ? main : undefined);
    if (main && threads.running(main)) {
      await Promise.race([threads.idle(main), new Promise((r) => setTimeout(r, MAIN_GRACE_MS))]);
      await recorder.flush();
      await stopThreads();
    }
  }

  /** The root's latest end, and whether it came after the root's latest start: an earlier claim's end does not count. */
  function rootEnd(events: readonly RunEvent[]) {
    let end: RunEvent | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.threadId !== root) continue;
      if (e.type === "thread.ended") end ??= e;
      if (e.type === "thread.started") return { end, thisClaim: end !== undefined };
    }
    return { end, thisClaim: false };
  }

  try {
    if (!signal?.aborted) await runtime.start();
    while (!signal?.aborted && !failed()) {
      const seen = version;
      const next = await runtime.section(step);
      if (next === "done") break;
      if (next === "acted") continue;
      await sleep(seen, next.wakeInMs);
    }
    if (!signal?.aborted && !failed()) await stopAll();
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
  const { end, thisClaim } = rootEnd(recorder.events());
  if (!signal?.aborted && !thisClaim) {
    const summary = end?.type === "thread.ended" ? end.payload.summary : undefined;
    recorder.emit(root, "thread.ended", { status: "completed", ...(summary && { summary }) });
  }
  return runtime.view();
}
