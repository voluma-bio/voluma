/**
 * The run loop: the code that keeps a run going while the main agent decides what to do.
 * It starts the main agent once and then, one step at a time inside the task runtime's
 * `section`, does the first applicable of: resume a thread a crash cut off, start the check
 * of a submitted task, write a finished check's result, deliver what happened to the main agent, and end a run whose main agent stops moving. It keeps no
 * state of its own: every step is a function of the stored events (`thread-log.ts`, `fold`)
 * plus which threads run in this process, so a resumed run and a first run are the same code.
 *
 * Workers are started by the main agent's `start_worker`, not here. The main agent hears
 * about the run only through delivery messages that resume it (`messages.ts`, which holds every
 * string an agent is told); a delivery's
 * `covers` is the last event it accounted for, so notices after it are still undelivered.
 * The run ends when the root thread has a completed `thread.ended` (`finish_run`, or the
 * liveness rule); then every thread without an end is stopped. A researcher's message to a
 * finished run reopens it (`run.reopened`, which clears the root's end): the message reaches the
 * main agent as a notice, like any other, and the run ends again when the main agent finishes.
 *
 * A thread that throws or is refused before it starts, a store failure, a fatal provider
 * error, or a main agent failing on the provider too often fails the run on purpose: the
 * threads are aborted and the root ends `failed`, because the loop must not carry on from a
 * record the store does not hold. A runtime abort writes no end, like a crash.
 */
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { By } from "@voluma/contracts/events";
import {
  checkResult,
  corrections,
  type Folded,
  type FoldedTask,
  fold,
  goMarkerId,
} from "@voluma/contracts/fold";
import type { WorkflowDefinition } from "@voluma/workflow/definition";
import type { UserSender } from "./adapters/pi/start-thread";
import type { RunLayout, ThreadLayout } from "./layout";
import {
  agentsList,
  answerText,
  CHECK_STOPPED,
  changedTasks,
  checkReason,
  cutOffText,
  deliveryText,
  fatalText,
  feedbackText,
  finishedRunText,
  fixLimitReason,
  interruptedResult,
  livenessNudge,
  STUCK_IN_CORRECTION,
  STUCK_PLAN_REASON,
  STUCK_SKIP_REASON,
  stateBlock,
  stuckSummary,
  unfinished,
  unresumableReason,
  verdictNudge,
} from "./messages";
import { checkPrompt, mainPrompt, mainRestartPrompt, systemPrompt, workerPrompt } from "./prompts";
import type { Recorder } from "./recorder";
import type { PlanTask, TaskRuntime } from "./task-runtime";
import {
  fixLimitReached,
  openAsk,
  type Role,
  startedFor,
  type ThreadIdentity,
  type ThreadLog,
  type ThreadRecord,
  type ThreadState,
  threadLog,
  threadState,
} from "./thread-log";
import type { ThreadSpec, Threads } from "./threads";

import type { Agents } from "./tools/main-tools";
import type { Tool } from "./tools/tool";

/** Where a thread sits in the run: stored on its `thread.started` by `begin`, not part of how a thread runs. */
type Lineage = { name: string; parentThreadId: string; attemptId?: string };

/** What the host decides about a thread's model; the loop adds the prompts, identity and tools. */
export interface ModelSetup {
  model: Model<Api>;
  /** The Pi agent's thinking level, which Pi sends as `reasoning` and records on each reply. */
  thinkingLevel: ThinkingLevel;
  streamFn: StreamFn;
}

/** A role of the workflow: the keys of `WorkflowDefinition.agents`. */
export type AgentRole = ThreadLayout["role"];

export interface LoopConfig {
  /** `needs-review` rounds a task gets before it is left to-check. */
  maxFixRounds: number;
  /** Deliveries with no notice in a row before code ends the run. */
  stuckLimit: number;
}

export const LOOP_DEFAULTS: LoopConfig = {
  maxFixRounds: 2,
  stuckLimit: 2,
};

export interface RunLoopOptions {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  runtime: TaskRuntime;
  threads: Threads;
  layout: RunLayout;
  /** The role files, skills and task files that write each thread's system prompt and first message. */
  definition: WorkflowDefinition;
  /** The outputs the researcher selected (every output when absent) and their notes, which the first messages carry. */
  selectedOutputs: readonly string[] | undefined;
  notes: string | undefined;
  /**
   * A thread's model. `recorded` is the model (`provider/id`) a resumed thread started on, which
   * it must keep.
   */
  model(role: AgentRole, recorded: string | undefined): ModelSetup;
  /** The tool names each role holds (`TOOL_NAMES`). */
  grants: Record<AgentRole, readonly string[]>;
  config?: Partial<LoopConfig>;
  /** Builds the tools a thread's role names; the main agent's tools act through `agents`. */
  tools(thread: ThreadLayout, names: readonly string[], agents: Agents): Tool[];
  /**
   * What a failed thread's error text means (the host knows its texts): `"fatal"` fails the run at
   * once; `"retry"` (an error the host's own call retry could not redo, as one in mid-reply)
   * resumes the thread once, then fails the run; `undefined` leaves it a failed thread.
   */
  providerError?(error: string): "retry" | "fatal" | undefined;
  signal?: AbortSignal;
}

/** How long the main agent gets to end its turn after the run ended. */
const MAIN_GRACE_MS = 15_000;

const rule = (r: Extract<By, { kind: "rule" }>["rule"]): By => ({ kind: "rule", rule: r });
const RUNTIME: UserSender = { kind: "runtime" };

/** What a step found: something done, nothing to do until the log changes, or the run is over. */
type Step = "acted" | "idle" | "done";

export async function runLoop(o: RunLoopOptions): Promise<Folded> {
  const { runId, rootThreadId: root, recorder, runtime, threads, signal } = o;
  const config = { ...LOOP_DEFAULTS, ...o.config };
  /** A thread resumed after a retryable provider error → its start count then; the resumed start's own failure is fatal. */
  const retriedAt = new Map<string, number>();
  let failure: unknown;
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
  async function sleep(seen: number) {
    if (version !== seen || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", done);
        waiters = waiters.filter((w) => w !== done);
        resolve();
      };
      signal?.addEventListener("abort", done, { once: true });
      waiters.push(done);
    });
  }

  const derive = () => threadLog(recorder.events());
  const stateOf = (r: ThreadRecord | undefined): ThreadState | undefined =>
    threadState(r, threads.running(r?.id ?? ""));

  /** The task's plain title for the researcher; the id when the plan has none. */
  const { taskName } = runtime;

  const planTask = (view: Folded, taskId: string): PlanTask => {
    const found = view.plan.tasks.find((t) => t.id === taskId);
    if (!found) throw new Error(`${taskId} is not a task of the plan`);
    return found;
  };

  function mainFirstMessage(view: Folded, n: number, d: ThreadLog) {
    // A main that starts when the open correction's message is still unread (a fresh `main.<n>`,
    // or the first main of a run made before corrections) was never told the run had finished.
    const message = corrections(recorder.events()).open?.message;
    const inCorrection = d.undelivered.some((u) => u.kind === "person" && u.eventId === message);
    const covers = { promptCovers: recorder.events().at(-1)?.id };
    const first = () => mainPrompt(view, o.selectedOutputs, o.definition.files, o.notes);
    if (n === 1 && !inCorrection) return { prompt: first() };
    const state = stateBlock(d, view, stateOf);
    const restart = () =>
      mainRestartPrompt(view, state, o.selectedOutputs, o.definition.files, o.notes);
    if (!inCorrection) return { prompt: restart(), ...covers };
    const brief = n === 1 ? `${first()}\n\n${state}` : restart();
    return { prompt: `${finishedRunText(view)}\n\n${brief}`, ...covers };
  }

  /** The start options for a thread; `prompt` is its first message, which a resumed thread uses only if it never stored one. */
  function specFor(r: ThreadIdentity) {
    const d = derive();
    const view = runtime.view();
    const taskId = r.taskId;
    const thread = o.layout.forThread(r, taskId ? (p) => runtime.cites(taskId, p) : undefined);
    const setup = o.model(r.role, d.threads.get(r.id)?.model);
    const common = {
      threadId: r.id,
      name: r.name,
      systemPrompt: systemPrompt(o.definition, thread),
      model: setup.model,
      thinkingLevel: setup.thinkingLevel,
      streamFn: setup.streamFn,
      tools: o.tools(thread, o.grants[r.role], agents),
      interrupted: (tool: string, toolCallId: string) =>
        interruptedResult(derive(), r.id, tool, toolCallId),
    };
    if (r.role === "main") {
      // Which main this is: its place among the mains logged so far (a new one is the next).
      const mains = [...d.threads.values()].filter((t) => t.role === "main");
      const at = mains.findIndex((t) => t.id === r.id);
      const n = (at === -1 ? mains.length : at) + 1;
      return {
        ...common,
        kind: "main" as const,
        parentThreadId: root,
        ...mainFirstMessage(view, n, d),
      } satisfies ThreadSpec & Lineage;
    }
    const task = planTask(view, r.taskId);
    const record = d.threads.get(r.id);
    if (r.role === "worker") {
      return {
        ...common,
        kind: "worker" as const,
        taskId: r.taskId,
        parentThreadId: d.main ?? root,
        prompt: workerPrompt(task, record?.brief ?? "", o.notes),
      } satisfies ThreadSpec & Lineage;
    }
    const folded = runtime.taskOf(r.taskId);
    if (!folded) throw new Error(`${r.taskId} has no folded task to check`);
    return {
      ...common,
      kind: "check" as const,
      taskId: r.taskId,
      parentThreadId: root,
      ...(folded.attemptId && { attemptId: folded.attemptId }),
      prompt: checkPrompt(task, folded, o.notes),
    } satisfies ThreadSpec & Lineage;
  }

  /**
   * Starts or resumes a thread. Its `thread.started` is stored first (id given), so the log
   * counts it at once, a stop's `cancelled` lands after it, and a new thread's id is never
   * reused. The loop steps again when the thread settles and
   * its end is stored. Call inside `section`: a stop cannot come between the append and the start.
   */
  async function begin(spec: ThreadSpec & Lineage, startedEventId: string, spawnedBy?: string) {
    const { name, parentThreadId, attemptId, ...start } = spec;
    await recorder.append(
      spec.threadId,
      "thread.started",
      {
        name,
        parentThreadId,
        kind: spec.kind,
        ...(spec.taskId && { task: spec.taskId }),
        ...(attemptId && { attemptId }),
        ...(spawnedBy && { spawnedBy }),
        model: `${spec.model.provider}/${spec.model.id}`,
        ...(spec.input && { input: spec.input }),
      },
      startedEventId,
    );
    threads.start(start);
    void threads
      .idle(spec.threadId)
      .then(() => recorder.flush())
      .then(nudge, nudge);
  }

  /** Resumes a thread that is not running, from its History, with a message. Never a stopped one. */
  async function resume(r: ThreadRecord, text: string, sender: UserSender) {
    if (stateOf(r) === "stopped") throw new Error(`${r.id} was stopped and is never resumed`);
    await begin({ ...specFor(r), input: { text, sender } }, `${r.id}:started:${r.starts + 1}`);
  }

  /**
   * The next thread of a task (`<task>.<role>[.<n>]`) or of the main agent (`main[.<n>]`), after
   * the `n` already logged; an id this process found unresumable is used up.
   */
  function nextThread(
    d: ThreadLog,
    of: { role: "main" } | { role: Role; taskId: string },
  ): ThreadIdentity {
    const base = of.role === "main" ? "main" : `${of.taskId}.${of.role}`;
    let n =
      (of.role === "main"
        ? [...d.threads.values()].filter((r) => r.role === "main").length
        : startedFor(d, of.taskId, of.role).length) + 1;
    const nameOf = (n: number) => (n === 1 ? base : `${base}.${n}`);
    while (threads.stale(`${runId}.${nameOf(n)}`)) n++;
    const named = { id: `${runId}.${nameOf(n)}`, name: nameOf(n) };
    return { ...named, ...of };
  }

  const startMain = (d: ThreadLog) => {
    const thread = nextThread(d, { role: "main" });
    return begin(specFor(thread), `${thread.id}:started`);
  };

  const startCheck = (d: ThreadLog, taskId: string) => {
    const thread = nextThread(d, { role: "check", taskId });
    return begin(specFor(thread), `${thread.id}:started`);
  };

  const agents: Agents = {
    state: (d, id) => threadState(d.threads.get(id), threads.running(id)),
    fixLimitReached: (d, taskId) => fixLimitReached(d, taskId, config.maxFixRounds),
    startWorker: async ({ taskId, brief, mainThreadId: main, spawnedBy, startedEventId }) => {
      const thread = nextThread(derive(), { role: "worker", taskId });
      const spec = specFor(thread);
      const task = planTask(runtime.view(), taskId);
      await begin(
        { ...spec, parentThreadId: main, prompt: workerPrompt(task, brief, o.notes) },
        startedEventId,
        spawnedBy,
      );
      return thread.id;
    },
    steer: (id, text, sender) => threads.send(id, text, sender),
    settled: (id) => threads.idle(id),
    resume: async (id, text, sender) => {
      const r = derive().threads.get(id);
      if (!r) throw new Error(`no thread ${id} to resume`);
      await resume(r, text, sender);
    },
    changed: nudge,
  };

  /** Whether the main agent is still in charge of nothing but waiting: no worker or checker runs. */
  const anyRunning = (d: ThreadLog) =>
    [...d.threads.values()].some((r) => r.role !== "main" && threads.running(r.id));

  /**
   * The thread a crash cut off is still the one in charge of its work. A worker is, whatever its
   * task's status (main may have resumed it on a finished task), unless a newer worker holds the
   * task, it handed the task over in this invocation, or the task is under review, stale or skipped.
   */
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
      !r.submitted &&
      !t?.skipped &&
      t?.status !== "under-review" &&
      t?.status !== "stale"
    );
  }

  /** Threads this process was refused as unresumable: the main agent starts over, a check is made again, a worker is stopped. */
  async function unresumable(d: ThreadLog): Promise<boolean> {
    for (const r of d.threads.values()) {
      const why = threads.stale(r.id);
      if (!why || dealtWith.has(r.id)) continue;
      dealtWith.add(r.id);
      if (r.role === "main") {
        if (d.main === r.id) {
          await startMain(d);
          return true;
        }
      } else {
        await runtime.stop(r.id, `${r.id}:unresumable`, unresumableReason(r.role, r.taskId, why));
        if (r.role === "check" && runtime.taskOf(r.taskId)?.threads.check === r.id) {
          await startCheck(derive(), r.taskId);
        }
        return true;
      }
    }
    return false;
  }

  async function resumeCutOff(d: ThreadLog): Promise<boolean> {
    for (const r of d.threads.values()) {
      if (stateOf(r) !== "cut-off" || threads.stale(r.id) || !inCharge(d, r)) continue;
      const tool = [...r.openCalls.values()].at(-1);
      const cutOff = cutOffText(d.after, tool);
      // A start cut off before its input landed: give the input again, after the cut-off line.
      const { text, sender } = r.inputPending ?? { text: "", sender: RUNTIME };
      await resume(r, text ? `${cutOff}\n\n${text}` : cutOff, sender);
      return true;
    }
    return false;
  }

  /**
   * An idle worker that holds an open attempt `message` opened but whose feedback never reached
   * it (a cut between the two writes): resume it with the stored text.
   */
  async function resumeFeedback(d: ThreadLog): Promise<boolean> {
    for (const r of d.threads.values()) {
      if (r.role !== "worker" || stateOf(r) !== "idle" || d.holders.get(r.taskId) !== r.id)
        continue;
      if (runtime.taskOf(r.taskId)?.status !== "in-progress") continue;
      if (!r.pendingFeedback) continue;
      const { text, from } = r.pendingFeedback;
      await resume(r, feedbackText(r.taskId, text), { kind: "thread", threadId: from });
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

  /** The result of a check: the task takes `checkResult`, or `to-check` when there was no verdict. */
  async function writeResult(d: ThreadLog, t: FoldedTask, c: ThreadRecord, reason?: string) {
    if (!t.attemptId) throw new Error(`${t.id} has no attempt to give a result`);
    const status = checkResult(t);
    const limit =
      t.checker?.verdict === "needs-review" && fixLimitReached(d, t.id, config.maxFixRounds, 1);
    const used = limit ? "fix-limit" : "check-result";
    await runtime.setStatus(
      c.id,
      `${c.id}:result`,
      t.id,
      t.attemptId,
      status,
      reason ??
        (used === "fix-limit" ? fixLimitReason(config.maxFixRounds) : checkReason(t, status)),
      rule(used),
    );
  }

  /** Check results, one action per call. */
  async function checks(d: ThreadLog, view: Folded): Promise<boolean> {
    for (const t of view.tasks) {
      if (t.status !== "under-review" || !t.threads.check) continue;
      const c = d.threads.get(t.threads.check);
      if (c?.role !== "check") continue;
      const state = stateOf(c);
      const verdict = t.checker?.verdict;
      const waiting = openAsk(c) !== undefined;
      if (state === "stopped" && !verdict) {
        await writeResult(d, t, c, CHECK_STOPPED);
        return true;
      }
      // A cut-off check without a verdict never gets here: `resumeCutOff` resumes it first.
      if (state === "running" || waiting) continue;
      // Idle, or stopped/cut off with a verdict: the check is over.
      const last = c.asks.at(-1);
      if (
        !verdict &&
        last?.answer &&
        (c.answeredAt ?? -1) > (c.heardAt ?? -1) &&
        state === "idle"
      ) {
        await resume(c, answerText(last.answer, t.id), {
          kind: "thread",
          threadId: d.main ?? root,
        });
        return true;
      }
      if (verdict) {
        await writeResult(d, t, c);
        return true;
      }
      if (c.end?.status === "completed" && c.nudges < 1) {
        await resume(c, verdictNudge(t.id), RUNTIME);
        return true;
      }
      await writeResult(d, t, c);
      return true;
    }
    return false;
  }

  /** Resumes a thread this process ran that failed on a retryable provider error (once); throws on any other provider error. */
  async function checkFatal(d: ThreadLog): Promise<boolean> {
    for (const r of d.threads.values()) {
      const error = r.end?.status === "failed" ? (r.end.error ?? "") : undefined;
      const kind =
        error !== undefined && threads.started(r.id) ? o.providerError?.(error) : undefined;
      if (!kind) continue;
      if (kind === "retry" && r.starts > (retriedAt.get(r.id) ?? -1) + 1 && !threads.stale(r.id)) {
        retriedAt.set(r.id, r.starts);
        await resume(r, "The model provider failed during your last reply; continue.", RUNTIME);
        return true;
      }
      throw new Error(fatalText(r, error as string, taskName));
    }
    return false;
  }

  /** The delivery message and the last event it covers. */
  function delivery(d: ThreadLog) {
    const events = recorder.events();
    const cut = d.cursor ? events.findIndex((e) => e.id === d.cursor) + 1 : 0;
    const changed = changedTasks(fold(events.slice(0, cut)), d.view);
    return {
      text: deliveryText(d.undelivered, agentsList(d, stateOf), changed),
      covers: events.at(-1)?.id,
    };
  }

  /**
   * The researcher's go opens a correction of its task: `revision.started` (keyed by the message),
   * written when the log shows the go and before the main agent is told, so the gate that
   * refuses its work tools opens with the notice and review has a boundary even when nothing
   * depends on the task.
   */
  async function markGo(d: ThreadLog): Promise<boolean> {
    const open = corrections(recorder.events()).open;
    for (const n of d.undelivered) {
      if (n.kind !== "person" || !n.go || n.eventId !== open?.message || !n.taskId) continue;
      const id = goMarkerId(n.eventId);
      if (d.written.has(id)) continue;
      await recorder.append(
        d.main ?? root,
        "revision.started",
        { reason: "correction", taskId: n.taskId },
        id,
      );
      return true;
    }
    return false;
  }

  /** Main is idle: tell it what happened, restart it, or end a run it stopped moving. */
  async function main(d: ThreadLog, view: Folded): Promise<boolean> {
    const m = d.main ? d.threads.get(d.main) : undefined;
    // A main agent stopped when an earlier correction ended is never resumed: the researcher's
    // message goes to a new one.
    if (m && stateOf(m) === "stopped" && d.undelivered.some((n) => n.kind === "person")) {
      await startMain(d);
      return true;
    }
    // A failed main (a context overflow) keeps the history that failed, so it is never resumed: a
    // fresh one takes over, once. If that one fails too, so does the run.
    if (m?.end?.status === "failed" && stateOf(m) === "idle") {
      const mains = [...d.threads.values()].filter((r) => r.role === "main");
      if (mains.at(-2)?.end?.status === "failed")
        throw new Error(fatalText(m, m.end.error ?? "", taskName));
      await startMain(d);
      return true;
    }
    if (!m || stateOf(m) !== "idle") return false;
    if (d.undelivered.length > 0) {
      const { text, covers } = delivery(d);
      await resume(m, text, { kind: "runtime", ...(covers && { covers }) });
      return true;
    }
    if (anyRunning(d)) return false;
    const covers = recorder.events().at(-1)?.id;
    if (d.emptyDeliveries < config.stuckLimit) {
      const asking = [...d.threads.values()].some((r) => r.role === "check" && openAsk(r));
      await resume(m, livenessNudge(asking, stateBlock(d, view, stateOf)), {
        kind: "runtime",
        ...(covers && { covers }),
      });
      return true;
    }
    await endStuckRun(d, view);
    return true;
  }

  /**
   * The main agent stopped moving: skip every unfinished task and end the run. A correction is
   * never ended that way, which would skip tasks that had results: the claim fails, and the
   * server records the failed correction and leaves the earlier results as they were.
   */
  async function endStuckRun(d: ThreadLog, view: Folded) {
    if (d.correcting) throw new Error(STUCK_IN_CORRECTION);
    const left = unfinished(view);
    if (left.length > 0) {
      await recorder.append(
        root,
        "plan.changed",
        {
          reason: STUCK_PLAN_REASON,
          skip: left.map((t) => ({ taskId: t.id, reason: STUCK_SKIP_REASON })),
        },
        `${root}:liveness:plan`,
      );
    }
    await recorder.append(
      root,
      "thread.ended",
      { status: "completed", summary: stuckSummary(left.map((t) => taskName(t.id))) },
      `${root}:liveness:end`,
    );
  }

  /** One decision, inside the section: the first thing that applies. */
  async function step(): Promise<Step> {
    await recorder.flush(); // a thread's end is stored before it is read
    const d = derive();
    if (d.root.ended) return "done";
    const view = d.view;
    if (await checkFatal(d)) return "acted";
    if (!d.main) {
      await startMain(d);
      return "acted";
    }
    if (await unresumable(d)) return "acted";
    if (await markGo(d)) return "acted";
    if (await resumeFeedback(d)) return "acted";
    if (await resumeCutOff(d)) return "acted";
    if (await startChecks(d, view)) return "acted";
    if (await checks(d, view)) return "acted";
    if (await main(d, view)) return "acted";
    return "idle";
  }

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

  try {
    if (!signal?.aborted) await runtime.start();
    while (!signal?.aborted && !failed()) {
      const seen = version;
      const next = await runtime.section(step);
      if (next === "done") break;
      if (next === "acted") continue;
      await sleep(seen);
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
  if (!signal?.aborted && !derive().root.endedThisClaim) {
    recorder.emit(root, "thread.ended", { status: "completed" });
  }
  return runtime.view();
}
