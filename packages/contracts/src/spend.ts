/**
 * What a run spent, per task and in total, derived from its events: the run screen's agent
 * cards and header call it. Pure: events in `seq` order in, plain data out; a prefix of the
 * log gives the spend so far.
 *
 * - Cost and tokens: the `usage` on each assistant `message` and each `wake`, plus a
 *   `tool.result`'s `costUsd` (a `segment_sam` call's Meta charge). Each counts for the
 *   thread that wrote the event.
 * - A worker or check thread belongs to the task its `thread.started` names, so a task's
 *   spend covers all its attempts: worker, check and any redo. The root thread (the main
 *   thread's wakes) belongs to no task: that is `main`. A chat thread counts only in `total`.
 * - Wall time is per thread invocation, from `thread.started` to its `thread.ended`, or to
 *   the thread's latest event while it has none (running, or cut off by a crash). A task's is
 *   the sum over its threads. `main`'s and `total`'s are the root thread's: the run's own
 *   working time, across resumes.
 * - Sandbox time is the time from a `bash` call to its result, `bash` being the one tool
 *   that runs in the sandbox. The sandbox's bill is its uptime (`Run.usage.sandboxSeconds`),
 *   which is longer: one sandbox serves every thread and idles between calls.
 *
 * The runner's end-of-run log line sums the same model and tool costs, so `total.costUsd`
 * matches it for a run that didn't lose events.
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
  /** By task id, in the order the tasks' first threads started. */
  tasks: Map<string, Spend>;
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
  const bash = new Map<string, number>();
  let root: string | undefined;

  const seconds = (from: number, to: number) => Math.max(0, to - from) / 1000;
  const add = (threadId: string, f: (s: Spend) => void) => {
    f(total);
    const s = owner.get(threadId);
    if (s) f(s);
  };
  const close = (threadId: string, at: number) => {
    const span = open.get(threadId);
    if (!span) return;
    open.delete(threadId);
    const wall = seconds(span.since, at);
    const s = owner.get(threadId);
    if (s) s.wallSeconds += wall;
    if (threadId === root) total.wallSeconds += wall;
  };

  for (const e of events) {
    const at = Date.parse(e.createdAt);
    const span = open.get(e.threadId);
    if (span) span.last = at;
    switch (e.type) {
      case "thread.started": {
        const { kind, task, parentThreadId } = e.payload;
        if (parentThreadId === null) root = e.threadId;
        if (!owner.has(e.threadId)) {
          let s: Spend | null = null;
          if (kind === "supervisor") s = main;
          else if (task !== undefined && (kind === "worker" || kind === "check")) {
            s = tasks.get(task) ?? empty();
            tasks.set(task, s);
          }
          owner.set(e.threadId, s);
        }
        // A start with no end before it was cut off: its span ends at its last event.
        if (span) close(e.threadId, span.last);
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
        if (e.payload.name === "bash") bash.set(e.payload.toolCallId, at);
        break;
      case "tool.result": {
        const { costUsd, toolCallId } = e.payload;
        const started = bash.get(toolCallId);
        bash.delete(toolCallId);
        add(e.threadId, (s) => {
          if (costUsd !== undefined) {
            s.costUsd += costUsd;
            s.toolCostUsd += costUsd;
          }
          if (started !== undefined) s.sandboxSeconds += seconds(started, at);
        });
        break;
      }
    }
  }
  for (const [threadId, span] of [...open]) close(threadId, span.last);
  return { tasks, main, total };
}
