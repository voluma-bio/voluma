/**
 * The live run page's data, derived from the run's events with no React: the threads (main,
 * worker, checker) with their latest action, the orchestration feed (one story across
 * threads) and one thread's transcript. All pure over `RunEvent[]` in `seq` order.
 *
 * Who speaks: only `wake` events are the main thread's voice (its note and decision). The
 * supervisor is code: starting a worker or a check, and the `task` events written `by` a rule,
 * are its mechanical steps and the feed shows them as such. The main thread has no message
 * events, so its thread transcript is its wakes plus the supervisor's own writes.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { WorkflowPlan } from "@voluma/contracts/workflow";

type Ev<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;

export type ThreadStatus = "running" | "completed" | "failed" | "cancelled";

export type Thread = {
  id: string;
  kind: "supervisor" | "worker" | "check" | "chat";
  taskId?: string;
  model?: string;
  startedAt: string;
  status: ThreadStatus;
  error?: string;
  toolCalls: number;
  toolErrors: number;
  /** The newest tool call, or the newest assistant text when there has been no call. */
  latest?: { text: string; running: boolean };
};

export type FeedEntry =
  | { id: string; kind: "plan"; at: string; plan: WorkflowPlan }
  | { id: string; kind: "wake"; at: string; event: Ev<"wake"> }
  | { id: string; kind: "thread"; at: string; threadId: string }
  /** A step the supervisor's code took, never the model's words. */
  | { id: string; kind: "step"; at: string; text: string; threadId: string }
  | { id: string; kind: "verdict"; at: string; event: Ev<"checkpoint"> }
  | { id: string; kind: "to-check"; at: string; event: Ev<"checkpoint"> }
  | { id: string; kind: "error"; at: string; text: string; threadId: string };

export type ThreadItem =
  | {
      kind: "message";
      id: string;
      at: string;
      role: "user" | "assistant" | "system";
      text: string;
    }
  | {
      kind: "tool";
      id: string;
      at: string;
      name: string;
      input: unknown;
      result?: { output: string; isError: boolean; truncated: boolean };
    }
  | { kind: "event"; id: string; at: string; event: RunEvent };

const ellipsis = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** One line for a tool call: the command for bash, the arguments otherwise. */
export function toolSummary(name: string, input: unknown): string {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (name === "bash" && typeof record.command === "string") {
    const line = record.command.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
    return ellipsis(line?.trim() ?? record.command, 140);
  }
  if (name === "checklist" && typeof record.status === "string") {
    return ellipsis(`${record.status}: ${String(record.reason ?? "")}`, 140);
  }
  const json = JSON.stringify(input);
  return ellipsis(json && json !== "{}" ? json : "", 140);
}

const supervisorId = (events: RunEvent[]) =>
  events.find((e) => e.type === "thread.started" && e.payload.kind === "supervisor")?.threadId;

/** Every thread the run has started, in start order. */
export function threadsOf(events: RunEvent[]): Thread[] {
  const threads = new Map<string, Thread>();
  const pending = new Map<string, Set<string>>();
  for (const e of events) {
    const t = threads.get(e.threadId);
    switch (e.type) {
      case "thread.started":
        if (t) t.status = "running";
        else
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
        }
        break;
      case "tool.call":
        if (t) {
          t.toolCalls++;
          t.latest = {
            text: `${e.payload.name} ${toolSummary(e.payload.name, e.payload.input)}`,
            running: true,
          };
          const open = pending.get(e.threadId) ?? new Set();
          open.add(e.payload.toolCallId);
          pending.set(e.threadId, open);
        }
        break;
      case "tool.result":
        if (t) {
          if (e.payload.isError) t.toolErrors++;
          pending.get(e.threadId)?.delete(e.payload.toolCallId);
          if (t.latest) t.latest.running = (pending.get(e.threadId)?.size ?? 0) > 0;
        }
        break;
      case "message":
        if (t && e.payload.role === "assistant" && e.payload.text && !t.latest)
          t.latest = { text: ellipsis(e.payload.text, 140), running: false };
        break;
    }
  }
  return [...threads.values()];
}

/** The plan the run started with. */
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

export function feedOf(events: RunEvent[]): FeedEntry[] {
  const supervisor = supervisorId(events);
  const feed: FeedEntry[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const entry = { id: e.id, at: e.createdAt };
    switch (e.type) {
      case "revision.started":
        if (e.payload.reason === "run") feed.push({ ...entry, kind: "plan", plan: e.payload.plan });
        else
          feed.push({
            ...entry,
            kind: "step",
            threadId: e.threadId,
            text:
              e.payload.reason === "fix"
                ? `The checker fixed ${e.payload.taskId}: a new revision of the results.`
                : `${e.payload.taskId} was corrected: a new revision of the results.`,
          });
        break;
      case "wake":
        feed.push({ ...entry, kind: "wake", event: e });
        break;
      case "thread.started":
        if (e.payload.kind !== "supervisor" && e.payload.kind !== "chat" && !seen.has(e.threadId)) {
          seen.add(e.threadId);
          feed.push({ ...entry, kind: "thread", threadId: e.threadId });
        }
        break;
      case "thread.ended":
        if (e.payload.status === "failed")
          feed.push({
            ...entry,
            kind: "error",
            threadId: e.threadId,
            text: e.payload.error ?? "The thread failed.",
          });
        break;
      case "sandbox":
        if (e.payload.state === "failed")
          feed.push({
            ...entry,
            kind: "error",
            threadId: e.threadId,
            text: `Sandbox ${e.payload.name} failed${e.payload.detail ? `: ${e.payload.detail}` : "."}`,
          });
        break;
      case "task":
        if (e.payload.by.kind !== "agent")
          feed.push({
            ...entry,
            kind: "step",
            threadId: e.threadId,
            text: `${e.payload.taskId} is now ${e.payload.status}. ${e.payload.reason}`,
          });
        break;
      case "judgment":
        feed.push({
          ...entry,
          kind: "step",
          threadId: supervisor ?? e.threadId,
          text: `Applied "${e.payload.applied.action}"${
            e.payload.applied.fallback === "redo-cap"
              ? " (the redo limit was reached)"
              : e.payload.applied.fallback === "error"
                ? " (the judgment failed, so it accepted)"
                : ""
          }.`,
        });
        break;
      case "checkpoint":
        if (e.payload.verdict) feed.push({ ...entry, kind: "verdict", event: e });
        if (e.payload.toCheck)
          feed.push({ ...entry, id: `${e.id}:to-check`, kind: "to-check", event: e });
        break;
    }
  }
  return feed;
}

/** One thread's transcript: its messages and tool calls (a call and its result are one item), then its other events. */
export function threadItemsOf(events: RunEvent[], threadId: string): ThreadItem[] {
  const items: ThreadItem[] = [];
  const calls = new Map<string, Extract<ThreadItem, { kind: "tool" }>>();
  for (const e of events) {
    if (e.threadId !== threadId) continue;
    const base = { id: e.id, at: e.createdAt };
    switch (e.type) {
      case "message":
        // A reply that only calls tools has empty text.
        if (e.payload.text)
          items.push({ ...base, kind: "message", role: e.payload.role, text: e.payload.text });
        break;
      case "tool.call": {
        const item: Extract<ThreadItem, { kind: "tool" }> = {
          ...base,
          kind: "tool",
          name: e.payload.name,
          input: e.payload.input,
        };
        calls.set(e.payload.toolCallId, item);
        items.push(item);
        break;
      }
      case "tool.result": {
        const call = calls.get(e.payload.toolCallId);
        if (call)
          call.result = {
            output: e.payload.output,
            isError: e.payload.isError,
            truncated: e.payload.truncated,
          };
        break;
      }
      default:
        items.push({ ...base, kind: "event", event: e });
    }
  }
  return items;
}
