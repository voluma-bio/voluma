/**
 * The live run page's run-level data, derived with no React from the run's events: the
 * threads (main, workers, checkers) with what each is doing now, the attention list, the plan
 * and where each task stands. Transcripts are in `transcript.ts`.
 */
import type { ModelUsage, RunEvent } from "@voluma/contracts/events";
import type { TaskStatus } from "@voluma/contracts/ids";
import type { WorkflowPlan } from "@voluma/contracts/workflow";
import { type Live, toolTitle } from "./transcript";
import { taskTitle } from "./workflows";

export type ThreadStatus = "running" | "completed" | "failed" | "cancelled";

export type Thread = {
  id: string;
  kind: "supervisor" | "worker" | "check" | "chat";
  taskId?: string;
  model?: string;
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

/** Every thread the run has started, in start order; `live` adds a call still being written. */
export function threadsOf(events: RunEvent[], live?: Live): Thread[] {
  const threads = new Map<string, Thread>();
  const running = new Map<string, Map<string, string>>();
  for (const e of events) {
    const t = threads.get(e.threadId);
    switch (e.type) {
      case "thread.started":
        if (t) {
          t.status = "running";
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
  for (const [id, calls] of running) {
    const t = threads.get(id);
    if (t) t.liveTool = [...calls.values()].at(-1);
  }
  if (live)
    for (const call of live.calls.values()) {
      const t = threads.get(call.threadId);
      if (t?.status === "running" && !t.liveTool) t.liveTool = "Writing a tool call…";
    }
  return [...threads.values()];
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
  threadId: string;
};

/** What needs a person first: failures, To check items, tasks left To check and checks that want review. */
export function attentionOf(events: RunEvent[]): Attention[] {
  const items: Attention[] = [];
  // A task's latest status, kept while it is To check and has no To check item of its own.
  const toCheck = new Map<string, Attention>();
  for (const e of events) {
    const base = { id: e.id, threadId: e.threadId };
    if (e.type === "thread.ended" && e.payload.status === "failed")
      items.push({ ...base, tone: "destructive", text: e.payload.error ?? "A thread failed." });
    else if (e.type === "sandbox" && e.payload.state === "failed")
      items.push({
        ...base,
        tone: "destructive",
        text: `Sandbox ${e.payload.name} failed${e.payload.detail ? `: ${e.payload.detail}` : "."}`,
      });
    else if (e.type === "checkpoint" && e.payload.toCheck) {
      items.push({ ...base, tone: "check", text: `To check: ${e.payload.toCheck.title}` });
      toCheck.delete(e.payload.taskId);
    } else if (e.type === "checkpoint" && e.payload.verdict === "needs-review")
      items.push({ ...base, tone: "check", text: `Needs review: ${taskTitle(e.payload.taskId)}` });
    else if (e.type === "task") {
      if (e.payload.status === "to-check")
        toCheck.set(e.payload.taskId, {
          ...base,
          tone: "check",
          text: `To check: ${taskTitle(e.payload.taskId)}. ${e.payload.reason}`,
        });
      else toCheck.delete(e.payload.taskId);
    }
  }
  return [...items, ...toCheck.values()];
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
  /** Not started, and every task it builds on is done. */
  | "ready"
  /** Not started, and a task it builds on is not done. */
  | "waiting";

/** Where each task stands, from the fold's statuses and the plan's dependencies. */
export function taskStates(
  plan: WorkflowPlan,
  statuses: Map<string, TaskStatus | undefined>,
): Map<string, TaskState> {
  const states = new Map<string, TaskState>();
  for (const t of plan.tasks) {
    const status = statuses.get(t.id);
    const blocked = t.dependsOn.some((d) => statuses.get(d) !== "done");
    states.set(
      t.id,
      status === "in-progress"
        ? "running"
        : status === "under-review"
          ? "checking"
          : status === "done" || status === "to-check" || status === "failed"
            ? status
            : blocked
              ? "waiting"
              : "ready",
    );
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
