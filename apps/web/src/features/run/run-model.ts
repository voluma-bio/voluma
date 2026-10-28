/**
 * The live run page's run-level data, derived with no React from the run's events: the
 * threads (main, workers, checkers) with what each is doing now, the attention list, the plan
 * and where each task stands. Transcripts are in `transcript.ts`.
 */
import type { ModelUsage, RunEvent } from "@voluma/contracts/events";
import type { FoldedTask } from "@voluma/contracts/fold";
import type { TaskStatus } from "@voluma/contracts/ids";
import type { WorkflowPlan } from "@voluma/contracts/workflow";
import { type Live, type RunEnd, toolTitle } from "./transcript";
import { taskTitle } from "./workflows";

export type ThreadStatus = "running" | "completed" | "failed" | "cancelled";

export type Thread = {
  id: string;
  kind: "supervisor" | "worker" | "check" | "chat";
  taskId?: string;
  model?: string;
  /** Its latest start: a woken thread's clock counts from its wake. */
  startedAt: string;
  endedAt?: string;
  status: ThreadStatus;
  error?: string;
  toolCalls: number;
  toolErrors: number;
  /** Model calls so far, and the sum of their usage; absent until one reports it. */
  calls: number;
  usage?: ModelUsage;
  /** The tool call running now, by title; else the last one it made. */
  liveTool?: string;
  lastTool?: string;
  /** The thread's last checkpoint, and its verdict for a checker. */
  result?: { text: string; verdict?: "passed" | "needs-review"; toCheck?: string };
  /** Its last prose, the report a finished card expands to. */
  said?: string;
};

export const addUsage = (a: ModelUsage | undefined, b: ModelUsage): ModelUsage => ({
  input: (a?.input ?? 0) + b.input,
  output: (a?.output ?? 0) + b.output,
  cacheRead: (a?.cacheRead ?? 0) + b.cacheRead,
  cacheWrite: (a?.cacheWrite ?? 0) + b.cacheWrite,
  costUsd: (a?.costUsd ?? 0) + b.costUsd,
});

/**
 * Every thread the run has started, in start order. A thread still open when the run ended
 * (`end`) is stopped then: a cancel ends the run in the API at once, and a killed runner never
 * writes its threads' `thread.ended`.
 */
export function threadsOf(events: RunEvent[], end?: RunEnd): Thread[] {
  const threads = new Map<string, Thread>();
  const running = new Map<string, Map<string, string>>();
  for (const e of events) {
    const t = threads.get(e.threadId);
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
            calls: 0,
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
        if (t)
          t.result = {
            text: e.payload.text,
            verdict: e.payload.verdict,
            toCheck: e.payload.toCheck?.title,
          };
        break;
      case "message":
        if (t && e.payload.role === "assistant") {
          t.calls++;
          if (e.payload.text) t.said = e.payload.text;
          if (e.payload.usage) t.usage = addUsage(t.usage, e.payload.usage);
        }
        break;
      case "wake":
        if (t) {
          t.calls++;
          if (e.payload.usage) t.usage = addUsage(t.usage, e.payload.usage);
        }
        break;
    }
  }
  for (const t of threads.values()) {
    if (t.status !== "running") continue;
    if (end) {
      t.status = "cancelled";
      t.endedAt = end.endedAt;
    } else t.liveTool = [...(running.get(t.id)?.values() ?? [])].at(-1);
  }
  return [...threads.values()];
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

export const threadRole = (t: Pick<Thread, "kind">) =>
  t.kind === "worker"
    ? "worker"
    : t.kind === "check"
      ? "checker"
      : t.kind === "supervisor"
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
 * thread, so a redone task drops it.
 */
export function attentionOf(
  tasks: FoldedTask[],
  threads: Thread[],
  events: RunEvent[],
): Attention[] {
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

export const planOf = (events: RunEvent[]): WorkflowPlan | undefined => {
  const first = events.find((e) => e.type === "revision.started" && e.payload.reason === "run");
  return first?.type === "revision.started" && first.payload.reason === "run"
    ? first.payload.plan
    : undefined;
};

/** The newest thread working on each task: the one a task row opens. */
export function latestThreadByTask(threads: Thread[]): Map<string, Thread> {
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
  /** Not started, and every task it builds on is done. */
  | "ready"
  /** Not started, and a task it builds on is not done. */
  | "waiting";

/**
 * Where each task stands, from the fold's statuses and the plan's dependencies. Once the run
 * has ended (`ended`), a task left in progress or under review is stopped: the log has no end
 * for the work the run cut off.
 */
export function taskStates(
  plan: WorkflowPlan,
  statuses: Map<string, TaskStatus | undefined>,
  /** Tasks with a worker running: Working before the worker marks it in progress. */
  working: Set<string>,
  ended: boolean,
): Map<string, TaskState> {
  const states = new Map<string, TaskState>();
  for (const t of plan.tasks) {
    const status = statuses.get(t.id);
    const blocked = t.dependsOn.some((d) => statuses.get(d) !== "done");
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
    states.set(t.id, ended && (state === "running" || state === "checking") ? "stopped" : state);
  }
  return states;
}

export type GraphNode = { id: string; level: number; row: number; dependsOn: string[] };

/** Plan tasks placed in columns by dependency depth, rows in plan order. */
export function layoutPlan(plan: WorkflowPlan): GraphNode[] {
  const level = new Map<string, number>();
  const depth = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    const task = plan.tasks.find((t) => t.id === id);
    const d = task && task.dependsOn.length > 0 ? 1 + Math.max(...task.dependsOn.map(depth)) : 0;
    level.set(id, d);
    return d;
  };
  const rows = new Map<number, number>();
  return plan.tasks.map((t) => {
    const l = depth(t.id);
    const row = rows.get(l) ?? 0;
    rows.set(l, row + 1);
    return { id: t.id, level: l, row, dependsOn: t.dependsOn };
  });
}
