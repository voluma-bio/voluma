/**
 * The run loop: the code that keeps a run going while the main agent decides what to do.
 * It starts the main agent once and then, one step at a time inside the task runtime's
 * `section`, does the first applicable of: resume a thread a crash cut off, start the check
 * of a submitted task, write a finished check's result, deliver what happened to the main agent, and end a run whose main agent stops moving. It keeps no
 * state of its own: every step is a function of the stored events (`thread-log.ts`, `fold`)
 * plus which threads run in this process, so a resumed run and a first run are the same code.
 *
 * Workers are started by the main agent's `start_agent`, not here. The main agent hears
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
  checkFailed,
  checkReason,
  cutOffText,
  deliveryText,
  fatalText,
  feedbackText,
  finishedRunText,
  fixLimitReason,
  interruptedResult,
  livenessNudge,
  PROVIDER_FAILED_RESUME,
  reviewingText,
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
import { threadIdOf } from "./thread-id";
import {
  checkAwaitsMain,
  fixLimitReached,
  inCharge,
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
type Lineage = { name: string; role: string; parentThreadId: string; attemptId?: string };

/** What the host decides about a thread's model; the loop adds the prompts, identity and tools. */
export interface ModelSetup {
  model: Model<Api>;
  /** The Pi agent's thinking level, which Pi sends as `reasoning` and records on each reply. */
  thinkingLevel: ThinkingLevel;
  streamFn: StreamFn;
}

export interface LoopConfig {
  /** `needs-review` rounds a task gets before it is left to-check. */
  maxFixRounds: number;
  /** Deliveries with no notice in a row before code ends the run. */
  stuckLimit: number;
}

/** The role file the run's first thread runs on; the loader requires it. */
const MAIN_ROLE = "main";

export const LOOP_DEFAULTS: LoopConfig = {
  maxFixRounds: 2,
  stuckLimit: 2,
};

/** The host's reading of a provider error's text (`RunLoopOptions.providerError`). */
export type ProviderError = "fatal" | "transient";

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
  model(role: string, recorded: string | undefined): ModelSetup;
  config?: Partial<LoopConfig>;
  /** Builds the tools a thread's role names; the main agent's tools act through `agents`. */
  tools(thread: ThreadLayout, agents: Agents): Tool[];
  /**
   * What a failed thread's error text means (the host knows its texts): `"fatal"` is a provider
   * error no later call can fix (auth, model not found, an empty account) and fails the run at
   * once; `"transient"` is one the model client already retried, before any reply (a rate limit,
   * a 5xx, a timeout), and fails the run on the main agent. `undefined`: not the provider's (a
   * context overflow), or a stream error, which the thread records as `interrupted` on its end.
   */
  providerError?(error: string): ProviderError | undefined;
  signal?: AbortSignal;
}

/** How many more checks than the attempts' own the main agent may start by replacing a failed one (`stop_worker`). */
const CHECK_REPLACEMENTS = 2;

/** How long the main agent gets to end its turn after the run ended. */
const MAIN_GRACE_MS = 15_000;

const rule = (r: Extract<By, { kind: "rule" }>["rule"]): By => ({ kind: "rule", rule: r });
const RUNTIME: UserSender = { kind: "runtime" };

/** What a step found: something done, nothing to do until the log changes, or the run is over. */
type Step = "acted" | "idle" | "done";

export async function runLoop(o: RunLoopOptions): Promise<Folded> {
  const { runId, rootThreadId: root, recorder, runtime, threads, signal } = o;
  const config = { ...LOOP_DEFAULTS, ...o.config };
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

  /**
   * What the open correction's message says the researcher was reviewing; empty when it names no
   * task. A resumed main (`resumed`) was told already when the message before this one named the
   * same task and item, so it is not told again.
   */
  function reviewing(view: Folded, messageId: string | undefined, resumed: boolean): string {
    const events = recorder.events();
    const at = events.findIndex((e) => e.id === messageId);
    const m = events[at];
    if (m?.type !== "person.message" || m.payload.go || !m.payload.taskId) return "";
    const { taskId, itemId, marks, snapshotKey } = m.payload;
    const before = events
      .slice(0, at)
      .reverse()
      .find((e) => e.type === "person.message");
    if (
      resumed &&
      before?.type === "person.message" &&
      !before.payload.go &&
      before.payload.taskId === taskId &&
      before.payload.itemId === itemId
    )
      return "";
    const check = view.tasks.find((t) => t.id === taskId)?.checks.find((c) => c.id === itemId);
    const found = check && { title: check.title, text: check.detail };
    return `\n\n${reviewingText({
      task: taskName(taskId),
      taskId,
      ...(found && { item: found }),
      attachments: !!snapshotKey || (marks ?? []).length > 0,
    })}`;
  }

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
    // A replacement main starts after the correction's message was delivered, and still needs to be told.
    if (!inCorrection)
      return { prompt: `${restart()}${reviewing(view, message, false)}`, ...covers };
    const brief = n === 1 ? `${first()}\n\n${state}` : restart();
    return {
      prompt: `${finishedRunText(view)}${reviewing(view, message, false)}\n\n${brief}`,
      ...covers,
    };
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
      role: r.role,
      systemPrompt: systemPrompt(o.definition, thread),
      model: setup.model,
      thinkingLevel: setup.thinkingLevel,
      streamFn: setup.streamFn,
      tools: o.tools(thread, agents),
      interrupted: (tool: string, toolCallId: string) =>
        interruptedResult(derive(), r.id, tool, toolCallId),
    };
    if (r.place === "main") {
      // Which main this is: its place among the mains logged so far (a new one is the next).
      const mains = [...d.threads.values()].filter((t) => t.place === "main");
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
    if (r.place === "worker") {
      return {
        ...common,
        kind: "worker" as const,
        taskId: r.taskId,
        parentThreadId: d.main ?? root,
        prompt: workerPrompt(
          task,
          record?.brief ?? "",
          view,
          o.selectedOutputs,
          o.definition.files,
          o.notes,
        ),
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
      prompt: checkPrompt(task, folded, view, o.selectedOutputs, o.definition.files, o.notes),
    } satisfies ThreadSpec & Lineage;
  }

  /**
   * Starts or resumes a thread. Its `thread.started` is stored first (id given), so the log
   * counts it at once, a stop's `cancelled` lands after it, and a new thread's id is never
   * reused. The loop steps again when the thread settles and
   * its end is stored. Call inside `section`: a stop cannot come between the append and the start.
   */
  async function begin(spec: ThreadSpec & Lineage, startedEventId: string, spawnedBy?: string) {
    const { name, role, parentThreadId, attemptId, ...start } = spec;
    await recorder.append(
      spec.threadId,
      "thread.started",
      {
        name,
        parentThreadId,
        kind: role,
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
    // An answer the worker has not heard goes with whatever resumes it (idle, cut off, failed),
    // and counts as heard only if a thread sent it.
    const d = derive();
    const ask = r.place === "worker" && inCharge(d, r) ? unheardAnswer(r) : undefined;
    if (r.place === "worker" && ask?.answer) {
      text = [answerText(ask.answer, r.taskId), text].filter(Boolean).join("\n\n");
      if (sender.kind !== "thread") sender = { kind: "thread", threadId: d.main ?? root };
    }
    await begin({ ...specFor(r), input: { text, sender } }, `${r.id}:started:${r.starts + 1}`);
  }

  /** The worker's latest ask when main answered it after the last message the worker got from a thread. */
  const unheardAnswer = (r: ThreadRecord) => {
    const last = r.asks.at(-1);
    return last?.answer && (r.answeredAt ?? -1) > (r.heardAt ?? -1) ? last : undefined;
  };

  /**
   * The next thread of a task (`<task>.<role>[.<n>]`) or of the main agent (`main[.<n>]`), after
   * the `n` already logged; an id this process found unresumable is used up.
   */
  function nextThread(
    d: ThreadLog,
    of: { place: "main" } | { place: Role; taskId: string },
    role: string,
  ): ThreadIdentity {
    const base = of.place === "main" ? "main" : `${of.taskId}.${of.place}`;
    let n =
      (of.place === "main"
        ? [...d.threads.values()].filter((r) => r.place === "main").length
        : startedFor(d, of.taskId, of.place).length) + 1;
    const nameOf = (n: number) => (n === 1 ? base : `${base}.${n}`);
    while (threads.stale(threadIdOf(runId, nameOf(n)))) n++;
    return { id: threadIdOf(runId, nameOf(n)), name: nameOf(n), role, ...of };
  }

  const startMain = (d: ThreadLog) => {
    const thread = nextThread(d, { place: "main" }, MAIN_ROLE);
    return begin(specFor(thread), `${thread.id}:started`);
  };

  /** The role that checks what the task's latest worker submitted: its role file's `checkedBy`. */
  const checkerOf = (taskId: string) => {
    const worker = runtime.taskOf(taskId)?.threads.worker;
    const role = worker && derive().threads.get(worker)?.role;
    const checker = role && o.definition.agents[role]?.checkedBy;
    if (!checker) throw new Error(`${taskId} has no role to check it`);
    return checker;
  };

  const startCheck = (d: ThreadLog, taskId: string) => {
    const thread = nextThread(d, { place: "check", taskId }, checkerOf(taskId));
    return begin(specFor(thread), `${thread.id}:started`);
  };

  const agents: Agents = {
    state: (d, id) => threadState(d.threads.get(id), threads.running(id)),
    fixLimitReached: (d, taskId) => fixLimitReached(d, taskId, config.maxFixRounds),
    startAgent: async ({ role, taskId, brief, mainThreadId: main, spawnedBy, startedEventId }) => {
      const thread = nextThread(derive(), { place: "worker", taskId }, role);
      const spec = specFor(thread);
      const task = planTask(runtime.view(), taskId);
      await begin(
        {
          ...spec,
          parentThreadId: main,
          prompt: workerPrompt(
            task,
            brief,
            runtime.view(),
            o.selectedOutputs,
            o.definition.files,
            o.notes,
          ),
        },
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
    replaceCheck: async (taskId) => {
      const d = derive();
      // The attempts' own checks, then CHECK_REPLACEMENTS more; past that the task is left to check.
      const limit = config.maxFixRounds + 1 + CHECK_REPLACEMENTS;
      if (startedFor(d, taskId, "check").length >= limit) return false;
      await startCheck(d, taskId);
      return true;
    },
    changed: nudge,
  };

  /** Whether the main agent is still in charge of nothing but waiting: no worker or checker runs. */
  const anyRunning = (d: ThreadLog) =>
    [...d.threads.values()].some((r) => r.place !== "main" && threads.running(r.id));

  /** Threads this process was refused as unresumable: the main agent starts over, a check is made again, a worker is stopped. */
  async function unresumable(d: ThreadLog): Promise<boolean> {
    for (const r of d.threads.values()) {
      const why = threads.stale(r.id);
      if (!why || dealtWith.has(r.id)) continue;
      dealtWith.add(r.id);
      if (r.place === "main") {
        if (d.main === r.id) {
          await startMain(d);
          return true;
        }
      } else {
        await runtime.stop(r.id, `${r.id}:unresumable`, unresumableReason(r.place, r.taskId, why));
        if (r.place === "check" && runtime.taskOf(r.taskId)?.threads.check === r.id) {
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
      if (r.place !== "worker" || stateOf(r) !== "idle" || d.holders.get(r.taskId) !== r.id)
        continue;
      if (runtime.taskOf(r.taskId)?.status !== "in-progress") continue;
      if (!r.pendingFeedback) continue;
      const { text, from } = r.pendingFeedback;
      await resume(r, feedbackText(r.taskId, text), { kind: "thread", threadId: from });
      return true;
    }
    return false;
  }

  /** An idle worker in charge of its task that main answered while it was not running: resume it with the answer. */
  async function answerIdleWorkers(d: ThreadLog): Promise<boolean> {
    for (const r of d.threads.values()) {
      if (r.place !== "worker" || stateOf(r) !== "idle" || !inCharge(d, r) || !unheardAnswer(r))
        continue;
      await resume(r, "", RUNTIME);
      return true;
    }
    return false;
  }

  /** A task `under-review` whose attempt has no check thread: start one. */
  async function startChecks(d: ThreadLog, view: Folded): Promise<boolean> {
    for (const t of view.tasks) {
      if (t.status !== "under-review" || !t.attemptId) continue;
      const c = t.threads.check ? d.threads.get(t.threads.check) : undefined;
      if (!c) {
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
      if (c?.place !== "check") continue;
      const state = stateOf(c);
      const verdict = t.checker?.verdict;
      const waiting = openAsk(d, c) !== undefined;
      // A check stopped with no verdict that no fresh check replaced: `stop_worker` past the
      // replacement limit, or a stop the loop itself made.
      if (state === "stopped" && !verdict) {
        await writeResult(d, t, c, CHECK_STOPPED);
        return true;
      }
      // A cut-off check without a verdict never gets here: `resumeCutOff` resumes it first.
      if (state === "running" || waiting) continue;
      // A failed check is main's to resume or replace; it is left to check only when main has
      // been told, is idle, and nothing else is running.
      if (checkAwaitsMain(d, c)) {
        const m = d.main ? d.threads.get(d.main) : undefined;
        const told = !d.undelivered.some((n) => n.threadId === c.id);
        // A failed main is `mainFailed`'s first: it may resume the check itself.
        if (!told || (m && (stateOf(m) !== "idle" || m.end?.status === "failed")) || anyRunning(d))
          continue;
        await writeResult(
          d,
          t,
          c,
          checkFailed(c.end?.error ?? "it failed", failureOf(c) !== undefined),
        );
        return true;
      }
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

  /** How a failed thread's error reads: the host's reading of its text, and `interrupted` from the thread's own end. */
  function failureOf(r: ThreadRecord): ProviderError | "interrupted" | undefined {
    if (r.end?.status !== "failed") return;
    const kind = o.providerError?.(r.end.error ?? "");
    return kind === "fatal" || !r.end.interrupted ? kind : "interrupted";
  }

  /**
   * Fails the run for a fatal provider error on a thread this process ran: a failure an earlier
   * claim recorded (a reopened run's) must not fail the new claim. Main's other failures are
   * `mainFailed`'s; a worker or check that failed stays a failed thread and main decides.
   */
  function checkFatal(d: ThreadLog) {
    for (const r of d.threads.values()) {
      if (failureOf(r) === "fatal" && threads.started(r.id)) {
        throw new Error(fatalText(r, r.end?.error ?? "", taskName));
      }
    }
  }

  /**
   * A failed main agent, idle. The rules for the failure's kind:
   * - a transient provider error (Pi's retries ran out before any reply) fails the run;
   * - an interrupted reply resumes the same main, history as it was, unless its previous end was
   *   an interrupted failure too and it has made no reply since its latest start: then the run fails;
   * - anything else (a context overflow, a length stop, a refusal) keeps the history that failed,
   *   so a fresh main takes over, once; if that one fails too, so does the run.
   */
  async function mainFailed(d: ThreadLog, m: ThreadRecord) {
    const fail = () => {
      throw new Error(fatalText(m, m.end?.error ?? "", taskName));
    };
    const kind = failureOf(m);
    if (kind === "transient" && threads.started(m.id)) fail();
    if (kind === "interrupted") {
      if (!m.replied && m.endBefore?.status === "failed" && m.endBefore.interrupted) fail();
      await resume(m, PROVIDER_FAILED_RESUME, RUNTIME);
      return;
    }
    const mains = [...d.threads.values()].filter((r) => r.place === "main");
    if (mains.at(-2)?.end?.status === "failed") fail();
    await startMain(d);
  }

  /** The delivery message and the last event it covers. */
  function delivery(d: ThreadLog) {
    const events = recorder.events();
    const cut = d.cursor ? events.findIndex((e) => e.id === d.cursor) + 1 : 0;
    const changed = changedTasks(fold(events.slice(0, cut)), d.view);
    const opening = corrections(events).open?.message;
    const intro = d.undelivered.some((n) => n.kind === "person" && n.eventId === opening)
      ? reviewing(fold(events), opening, true)
      : "";
    return {
      text: `${deliveryText(d, d.undelivered, agentsList(d, stateOf), changed)}${intro}`,
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
    if (m?.end?.status === "failed" && stateOf(m) === "idle") {
      await mainFailed(d, m);
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
      const asking = [...d.threads.values()].some((r) => openAsk(d, r));
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
    checkFatal(d);
    if (!d.main) {
      await startMain(d);
      return "acted";
    }
    if (await unresumable(d)) return "acted";
    if (await markGo(d)) return "acted";
    if (await resumeFeedback(d)) return "acted";
    if (await answerIdleWorkers(d)) return "acted";
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
