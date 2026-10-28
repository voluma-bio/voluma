/**
 * What a run spent, per task and in total, derived from its events: the run screen's agent
 * cards and header call it. Pure: events in `seq` order in, plain data out; a prefix of the
 * log gives the spend so far.
 *
 * - Cost and tokens: the `usage` on each assistant `message` and each `wake`, plus a
 *   `tool.result`'s `costUsd` (a `segment_sam` call's Meta charge). Each counts for the
 *   thread that wrote the event; an event from a thread with no `thread.started` before it
 *   counts only in `total`.
 * - A worker or check thread belongs to the task its `thread.started` names, so a task's
 *   spend covers all its attempts: worker, check and any redo. The root thread (the main
 *   thread's wakes) belongs to no task: that is `main`. A chat thread counts only in `total`.
 * - Wall time is per thread invocation, from `thread.started` to its `thread.ended`, or to
 *   the thread's latest event while it has none (running, or cut off by a crash). A task's is
 *   the sum over its threads. `main`'s and `total`'s are the root thread's, whose open span
 *   ends at the log's latest event: the run's own working time, across resumes. The root
 *   starting again means the runner restarted, so every open span ends there, each at its
 *   own latest event.
 * - Sandbox time is the time from a `bash` call to its result, `bash` being the one tool
 *   that runs in the sandbox; a call cut off by a restart counts nothing. The sandbox's
 *   bill is its uptime (`Run.usage.sandboxSeconds`), which is longer: one sandbox serves
 *   every thread and idles between calls.
 *
 * The runner's end-of-run log line sums the same model and tool costs over the run's
 * threads, so `total.costUsd` matches it for a run that didn't lose events (a review chat
 * thread is not the runner's).
 */
import type { RunEvent } from "./events";

export type Spend = {
  /** Model calls plus paid tool calls, in US dollars. */
  costUsd: number;
  /** The paid tool calls' part of `costUsd`. */
  toolCostUsd: number;
  /** Model calls that reported usage. */
  calls: number;
  /** Uncached input tokens (`ModelUsage.input`). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  wallSeconds: number;
  sandboxSeconds: number;
};

export type RunSpend = {
  /** In the order the tasks' first threads started. */
  tasks: { taskId: string; spend: Spend }[];
  main: Spend;
  total: Spend;
};

const empty = (): Spend => ({
  costUsd: 0,
  toolCostUsd: 0,
  calls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  wallSeconds: 0,
  sandboxSeconds: 0,
});

/** The share of prompt tokens read from cache, `cacheRead / (input + cacheRead)`; null with no calls. */
export const cacheHitShare = (s: Spend): number | null =>
  s.input + s.cacheRead > 0 ? s.cacheRead / (s.input + s.cacheRead) : null;

export function spend(events: readonly RunEvent[]): RunSpend {
  const tasks = new Map<string, Spend>();
  const main = empty();
  const total = empty();
  // threadId → the Spend it counts in besides `total` (none for chat threads).
  const owner = new Map<string, Spend | null>();
  const open = new Map<string, { since: number; last: number }>();
  // toolCallId → the `bash` call's thread and start.
  const bash = new Map<string, { threadId: string; at: number }>();
  let root: string | undefined;
  // The log's latest event time so far: the root thread's span ends there, since the root is
  // quiet while its workers run.
  let latest = Number.NEGATIVE_INFINITY;

  const seconds = (from: number, to: number) => Math.max(0, to - from) / 1000;
  const add = (threadId: string, f: (s: Spend) => void) => {
    f(total);
    const s = owner.get(threadId);
    if (s) f(s);
  };
  // Ends a thread's open span, the root's at the log's latest event and any other at its own,
  // and forgets its unanswered `bash` calls: a resume answers them with a repair result.
  const close = (threadId: string, at?: number) => {
    const span = open.get(threadId);
    if (span) {
      open.delete(threadId);
      const wall = seconds(span.since, at ?? (threadId === root ? latest : span.last));
      const s = owner.get(threadId);
      if (s) s.wallSeconds += wall;
      if (threadId === root) total.wallSeconds += wall;
    }
    for (const [id, call] of bash) if (call.threadId === threadId) bash.delete(id);
  };

  for (const e of events) {
    const at = Date.parse(e.createdAt);
    switch (e.type) {
      case "thread.started": {
        const { kind, task, parentThreadId } = e.payload;
        if (parentThreadId === null && kind === "supervisor") {
          // The root starts again only after the runner restarted, which cut off every thread.
          root = e.threadId;
          for (const threadId of [...open.keys()]) close(threadId);
        } else close(e.threadId);
        if (!owner.has(e.threadId)) {
          let s: Spend | null = null;
          if (kind === "supervisor") s = main;
          else if (task !== undefined && (kind === "worker" || kind === "check")) {
            s = tasks.get(task) ?? empty();
            tasks.set(task, s);
          }
          owner.set(e.threadId, s);
        }
        open.set(e.threadId, { since: at, last: at });
        break;
      }
      case "thread.ended":
        close(e.threadId, at);
        break;
      case "message":
      case "wake": {
        const used =
          e.type === "wake"
            ? e.payload.usage
            : e.payload.role === "assistant"
              ? e.payload.usage
              : undefined;
        if (!used) break;
        add(e.threadId, (s) => {
          s.costUsd += used.costUsd;
          s.calls++;
          s.input += used.input;
          s.output += used.output;
          s.cacheRead += used.cacheRead;
          s.cacheWrite += used.cacheWrite;
        });
        break;
      }
      case "tool.call":
        if (e.payload.name === "bash") bash.set(e.payload.toolCallId, { threadId: e.threadId, at });
        break;
      case "tool.result": {
        const { costUsd, toolCallId } = e.payload;
        const call = bash.get(toolCallId);
        bash.delete(toolCallId);
        add(e.threadId, (s) => {
          if (costUsd !== undefined) {
            s.costUsd += costUsd;
            s.toolCostUsd += costUsd;
          }
          if (call) s.sandboxSeconds += seconds(call.at, at);
        });
        break;
      }
    }
    const span = open.get(e.threadId);
    if (span) span.last = at;
    latest = Math.max(latest, at);
  }
  for (const threadId of [...open.keys()]) close(threadId);
  return { tasks: [...tasks].map(([taskId, s]) => ({ taskId, spend: s })), main, total };
}
