/**
 * The live run page's run-level data, derived with no React from the run's events and state:
 * the threads (main, workers, checkers) with what each is doing now, the attention list, the
 * plan, where each task stands and how it ended, the values reported so far, and what the run
 * spent. Transcripts are in `transcript.ts`.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { Folded, FoldedTask } from "@voluma/contracts/fold";
import type { ProviderCalls, RunState } from "@voluma/contracts/run";
import { type RunSpend, type Spend, spend } from "@voluma/contracts/spend";
import { openThreads } from "@voluma/contracts/threads";
import type { WorkflowPlan } from "@voluma/contracts/workflow";
import { isSatisfied } from "@voluma/workflow";
import { catalog } from "@voluma/workflow/bundled";
import { type Halt, type Live, toolTitle } from "./transcript";

const { outputName, taskTitle } = catalog["mouse-oa"];

/** `paused`: open while the run waits for a runner or keys; it resumes with a `thread.started`. */
export type ThreadStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

export type Thread = {
  id: string;
  kind: "supervisor" | "main" | "worker" | "check" | "chat";
  taskId?: string;
  model?: string;
  /** Its latest start: a resumed thread's clock counts from its resume. */
  startedAt: string;
  /** Where its clock stops: its end, the run's end, or its last event while paused. */
  endedAt?: string;
  status: ThreadStatus;
  error?: string;
  toolCalls: number;
  toolErrors: number;
  /** A worker's or checker's own cost and time; the run's spend has the main thread's. */
  spend?: Spend;
  /** The tool call running now, by title; else the last one it made. */
  liveTool?: string;
  lastTool?: string;
  /** The thread's last checkpoint, and its verdict for a checker. */
  result?: { text: string; verdict?: "passed" | "needs-review" };
  /** Its last prose, the report a finished card expands to. */
  said?: string;
};

/**
 * When the runner is not running the run's threads (see `Halt`). A queued run with no threads
 * open is paused too, which changes nothing. An ended run halts only once its stream has
 * closed: until then the cancel's thread ends may still be on the way.
 */
export function haltOf(state: RunState, streamClosed: boolean): Halt | undefined {
  switch (state.status) {
    case "running":
      return undefined;
    case "queued":
    case "awaiting-keys":
      return { kind: "paused" };
    case "ended":
      return streamClosed
        ? { kind: "ended", at: state.endedAt, outcome: state.outcome }
        : undefined;
  }
}

/**
 * Every thread the run has started, in start order, as the log tells it; `halted` applies what
 * the log can't say.
 */
function threadsOf(events: RunEvent[]): { threads: Thread[]; lastAt: Map<string, string> } {
  const threads = new Map<string, Thread>();
  const running = new Map<string, Map<string, string>>();
  const lastAt = new Map<string, string>();
  const own = new Map<string, RunEvent[]>();
  for (const e of events) {
    const t = threads.get(e.threadId);
    lastAt.set(e.threadId, e.createdAt);
    const mine = own.get(e.threadId);
    if (mine) mine.push(e);
    else own.set(e.threadId, [e]);
    switch (e.type) {
      case "thread.started":
        if (t) {
          t.status = "running";
          t.startedAt = e.createdAt;
          t.endedAt = undefined;
        } else
          threads.set(e.threadId, {
            id: e.threadId,
            kind: e.payload.kind,
            taskId: e.payload.task,
            model: e.payload.model,
            startedAt: e.createdAt,
            status: "running",
            toolCalls: 0,
            toolErrors: 0,
          });
        break;
      case "thread.ended":
        if (t) {
          t.status = e.payload.status;
          t.error = e.payload.error;
          t.endedAt = e.createdAt;
          running.delete(e.threadId);
        }
        break;
      case "tool.call":
        if (t) {
          t.toolCalls++;
          const calls = running.get(e.threadId) ?? new Map<string, string>();
          t.lastTool = toolTitle(e.payload.name, e.payload.input);
          calls.set(e.payload.toolCallId, t.lastTool);
          running.set(e.threadId, calls);
        }
        break;
      case "tool.result":
        if (t) {
          if (e.payload.isError) t.toolErrors++;
          running.get(e.threadId)?.delete(e.payload.toolCallId);
        }
        break;
      case "checkpoint":
        if (t) t.result = { text: e.payload.text, verdict: e.payload.verdict };
        break;
      case "message":
        if (t && e.payload.role === "assistant" && e.payload.text) t.said = e.payload.text;
        break;
    }
  }
  for (const t of threads.values()) {
    if (t.status === "running") t.liveTool = [...(running.get(t.id)?.values() ?? [])].at(-1);
    // `spend` over one worker's or checker's events counts them all for its task, so that one
    // task's spend is the thread's own.
    if (t.kind === "worker" || t.kind === "check")
      t.spend = spend(own.get(t.id) ?? []).tasks[0]?.spend;
  }
  return { threads: [...threads.values()], lastAt };
}

/**
 * A thread still open when the runner stopped: a lost runner writes no end, and a cancel's ends
 * are all in the log once the stream has closed, so only a failed run leaves threads here.
 * It is stopped (failed, if the run failed) at the run's end, or paused at its last event while
 * the run waits to resume.
 */
function halted(threads: Thread[], lastAt: Map<string, string>, halt: Halt): Thread[] {
  return threads.map((t) =>
    t.status !== "running"
      ? t
      : halt.kind === "ended"
        ? {
            ...t,
            status: halt.outcome === "failed" ? "failed" : "cancelled",
            endedAt: halt.at,
            liveTool: undefined,
          }
        : { ...t, status: "paused", endedAt: lastAt.get(t.id), liveTool: undefined },
  );
}

/** Threads with a tool call still being written and none running say so; others are kept as is. */
export function withLiveCalls(threads: Thread[], live: Live): Thread[] {
  const writing = new Set([...live.calls.values()].map((c) => c.threadId));
  if (writing.size === 0) return threads;
  return threads.map((t) =>
    t.status === "running" && !t.liveTool && writing.has(t.id)
      ? { ...t, liveTool: "Writing a tool call…" }
      : t,
  );
}

const threadRole = (t: Pick<Thread, "kind">) =>
  t.kind === "worker"
    ? "worker"
    : t.kind === "check"
      ? "checker"
      : t.kind === "supervisor" || t.kind === "main"
        ? "Main thread"
        : "Chat";

/** "Segmentation worker", "Intake checker", "Main thread". */
export const threadName = (t: Pick<Thread, "kind" | "taskId">) =>
  t.taskId ? `${taskTitle(t.taskId)} ${threadRole(t)}` : threadRole(t);

export type Attention = {
  id: string;
  tone: "destructive" | "check";
  text: string;
  /** The thread the item opens; null opens the main thread. */
  threadId: string | null;
};

/**
 * What needs a person first, from the fold's tasks so it agrees with review: each To check
 * item, a check that wants review, and failures. A failure counts only on a task's latest
 * thread, so a redone task drops it. `threads` are as logged: a thread the run's failure cut
 * off is the run's error, which the page shows on its own.
 */
function attentionOf(tasks: FoldedTask[], threads: Thread[], events: RunEvent[]): Attention[] {
  const items: Attention[] = [];
  const latest = latestThreadByTask(threads);
  for (const t of threads)
    if (t.status === "failed" && (!t.taskId || latest.get(t.taskId) === t))
      items.push({
        id: `failed:${t.id}`,
        tone: "destructive",
        text: `${threadName(t)} failed${t.error ? `: ${t.error}` : "."}`,
        threadId: t.id,
      });
  for (const e of events)
    if (e.type === "sandbox" && e.payload.state === "failed")
      items.push({
        id: e.id,
        tone: "destructive",
        text: `Sandbox ${e.payload.name} failed${e.payload.detail ? `: ${e.payload.detail}` : "."}`,
        threadId: e.threadId,
      });
  for (const task of tasks) {
    const threadId = task.threads.check ?? task.threads.worker;
    const title = taskTitle(task.id);
    if (
      (task.status === "under-review" || task.status === "to-check") &&
      task.checker?.verdict === "needs-review"
    )
      items.push({
        id: `review:${task.id}`,
        tone: "check",
        text: `Needs review: ${title}`,
        threadId,
      });
    if (task.status !== "to-check") continue;
    for (const c of task.checks)
      items.push({ id: `check:${c.id}`, tone: "check", text: `${title}: ${c.title}`, threadId });
    if (task.checks.length === 0)
      items.push({
        id: `to-check:${task.id}`,
        tone: "check",
        text: `To check: ${title}${task.reason ? `. ${task.reason}` : ""}`,
        threadId,
      });
  }
  return items;
}

/** The newest thread working on each task: the one a task row opens. */
function latestThreadByTask(threads: Thread[]): Map<string, Thread> {
  const byTask = new Map<string, Thread>();
  for (const t of threads) if (t.taskId) byTask.set(t.taskId, t);
  return byTask;
}

export type TaskState =
  | "running"
  | "checking"
  | "done"
  | "to-check"
  | "failed"
  /** Working or being checked when the run ended. */
  | "stopped"
  /** Working or being checked while the run waits for a runner or keys. */
  | "paused"
  /** Not started, and every task it builds on has a usable result (`isSatisfied`). */
  | "ready"
  /** Not started, and a task it builds on has no usable result yet. */
  | "waiting";

/**
 * Where each task stands, from the fold's statuses and the plan's dependencies. A task with a
 * worker open is Working before the worker marks it in progress. While the runner is stopped
 * (`halt`), a task left in progress or under review is stopped or paused: the log has no end
 * for the work it cut off.
 */
function taskStates(
  plan: WorkflowPlan,
  tasks: FoldedTask[],
  threads: Thread[],
  /** `openThreads`: a worker the log shows open counts as working, then stopped if the run is halted. */
  open: ReadonlySet<string>,
  halt: Halt | undefined,
): Map<string, TaskState> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const working = new Set(
    threads.flatMap((t) => (t.kind === "worker" && open.has(t.id) && t.taskId ? [t.taskId] : [])),
  );
  const states = new Map<string, TaskState>();
  for (const t of plan.tasks) {
    const status = byId.get(t.id)?.status;
    const blocked = t.dependsOn.some((d) => !isSatisfied(byId.get(d)));
    const state: TaskState =
      status === "in-progress" ||
      ((status === undefined || status === "pending" || status === "stale") && working.has(t.id))
        ? "running"
        : status === "under-review"
          ? "checking"
          : status === "done" || status === "to-check" || status === "failed"
            ? status
            : blocked
              ? "waiting"
              : "ready";
    states.set(
      t.id,
      halt && (state === "running" || state === "checking")
        ? halt.kind === "ended"
          ? "stopped"
          : "paused"
        : state,
    );
  }
  return states;
}

/** A task's row in the Tasks list, in plan order. */
export type TaskRow = {
  id: string;
  state: TaskState;
  /** Its newest thread: the row opens it, and a working row shows its clock. */
  thread?: Thread;
  /** How it ended, once it has (`outcomes`). */
  outcome?: string;
  /** While waiting: the tasks it builds on that have no usable result yet. */
  waitingOn?: string[];
  /** Its worker, check and any redo together, once it has spent anything. */
  spend?: Spend;
};

const ENDED: ReadonlySet<TaskState> = new Set(["done", "to-check", "failed", "stopped"]);

/**
 * Each ended task's outcome line: its current attempt's last checkpoint from the worker (the
 * result in the worker's words, with its numbers), else the checker's. A
 * failed task says why it failed. Not the closing `task` reason, a rule's stock sentence ("The second agent
 * checked this task and agrees"): it is about the check, not the result.
 */
function outcomes(
  events: RunEvent[],
  tasks: FoldedTask[],
  states: Map<string, TaskState>,
): Map<string, string> {
  const byAttempt = new Map(tasks.flatMap((t) => (t.attemptId ? [[t.attemptId, t] as const] : [])));
  const worker = new Map<string, string>();
  const checker = new Map<string, string>();
  for (const e of events) {
    if (e.type === "checkpoint") {
      const t = byAttempt.get(e.payload.attemptId);
      if (t) (e.threadId === t.threads.worker ? worker : checker).set(t.id, e.payload.text);
    }
  }
  const lines = new Map<string, string>();
  for (const t of tasks) {
    const state = states.get(t.id);
    if (!state || !ENDED.has(state)) continue;
    const line = state === "failed" ? t.reason : (worker.get(t.id) ?? checker.get(t.id));
    if (line) lines.set(t.id, line);
  }
  return lines;
}

/** One reported value in "Outputs so far". */
export type OutputRow = {
  /** `taskId/outputId`. */
  id: string;
  title: string;
  /** "4.93 mm³", a score's level; null when there is none. */
  value: string | null;
  /**
   * Why there is no value (the worker's note, or that the task finished without reporting it),
   * or why a shown value may no longer hold (its task is stale).
   */
  reason?: string;
};

const SUPERSCRIPT: Record<string, string> = { "^2": "²", "^3": "³", "^-1": "⁻¹" };

/** Up to three significant digits (whole numbers from 1,000), then the unit: "4.93 mm³", "67.3%". */
function formatValue(value: number, unit: string): string {
  const n = new Intl.NumberFormat("en-US", {
    ...(Math.abs(value) >= 1000 ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 3 }),
  }).format(value);
  if (unit === "1" || unit === "") return n;
  if (unit === "%") return `${n}%`;
  return `${n} ${unit.replace(/\^-?\d/g, (p) => SUPERSCRIPT[p] ?? p)}`;
}

/**
 * The values reported so far, by task in plan order: each measurement and score of the task's
 * current attempt (files, volumes, structures and annotations carry no value to read here; the
 * review shows them), then, once the task has finished (done, to check or failed), each required
 * one it never reported.
 */
function outputRows(
  plan: WorkflowPlan,
  tasks: FoldedTask[],
  states: Map<string, TaskState>,
): OutputRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return plan.tasks.flatMap((p) => {
    const t = byId.get(p.id);
    if (!t) return [];
    const rows: OutputRow[] = [
      ...t.measurements.map((m) => ({
        id: m.id,
        title: m.title ?? m.id,
        value: m.value === null ? null : formatValue(m.value, m.unit),
        ...(m.value === null && { reason: m.note ?? "No value given" }),
      })),
      ...t.scores.map((s) => ({ id: s.id, title: s.title ?? s.id, value: s.level })),
    ];
    // A task made stale by a change upstream keeps its old attempt until it is redone.
    if (t.status === "stale")
      for (const r of rows)
        if (r.value !== null) r.reason = `May no longer hold${t.reason ? `: ${t.reason}` : ""}`;
    // A stopped task's row says so; only a task that finished its work left an output out.
    const state = states.get(p.id);
    if (state === "done" || state === "to-check" || state === "failed")
      for (const m of t.missing)
        if (m.kind === "measurement" || m.kind === "score")
          rows.push({
            id: `${p.id}/${m.outputId}`,
            title: outputName(m.outputId),
            value: null,
            reason: m.reason ?? "Not reported",
          });
    return rows;
  });
}

export type RunView = {
  /** Without the tool calls still being written: `withLiveCalls` adds those per frame. */
  threads: Thread[];
  attention: Attention[];
  plan?: WorkflowPlan;
  /** One per plan task, in plan order; empty until the run has a plan. */
  tasks: TaskRow[];
  outputs: OutputRow[];
  /** "3 of 7 finished, 1 to check". */
  progress: string;
  /** Cost and time per task, for the main thread and in total. */
  spend: RunSpend;
};

/** Everything the run page shows about the run as a whole, from its durable events. */
export function runView(
  events: RunEvent[],
  folded: Folded,
  halt: Halt | undefined,
  providerCalls: ProviderCalls | undefined,
): RunView {
  const logged = threadsOf(events);
  const threads = halt ? halted(logged.threads, logged.lastAt, halt) : logged.threads;
  // No plan until the run's first `revision.started`.
  const plan = folded.revisions.length > 0 ? folded.plan : undefined;
  const attention = attentionOf(folded.tasks, logged.threads, events);
  const spent = spend(events, providerCalls);
  if (!plan) return { threads, attention, tasks: [], outputs: [], progress: "", spend: spent };
  const states = taskStates(plan, folded.tasks, threads, new Set(openThreads(events)), halt);
  const latest = latestThreadByTask(threads);
  const lines = outcomes(events, folded.tasks, states);
  const taskSpend = new Map(spent.tasks.map((t) => [t.taskId, t.spend]));
  const folds = new Map(folded.tasks.map((t) => [t.id, t]));
  const tasks = plan.tasks.map((t) => ({
    id: t.id,
    state: states.get(t.id) ?? "waiting",
    thread: latest.get(t.id),
    outcome: lines.get(t.id),
    waitingOn:
      states.get(t.id) === "waiting"
        ? t.dependsOn.filter((d) => !isSatisfied(folds.get(d)))
        : undefined,
    spend: taskSpend.get(t.id),
  }));
  // To check is finished too: the work is done and a person has items to look at.
  const done = tasks.filter((t) => t.state === "done" || t.state === "to-check").length;
  const toCheck = tasks.filter((t) => t.state === "to-check").length;
  return {
    threads,
    attention,
    plan,
    tasks,
    outputs: outputRows(plan, folded.tasks, states),
    progress: `${done} of ${tasks.length} finished${toCheck > 0 ? `, ${toCheck} to check` : ""}`,
    spend: spent,
  };
}
