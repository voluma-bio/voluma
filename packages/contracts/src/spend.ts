/**
 * What a run spent, per thread, per task and in total, derived from its events: the run
 * screen's agent cards and header call it. Pure: events in `seq` order in, plain data out; a
 * prefix of the log gives the spend so far.
 *
 * - Everything is counted per thread first (`threads`); a task's spend, `main` and `total` are
 *   sums over threads.
 * - Cost and tokens: the `usage` on each assistant `message`, for the thread that wrote the
 *   event; an event from a thread with no `thread.started` before it counts only in `total`.
 * - Provider calls (the gateway's, `Run.providerCalls`) are passed in separately and added
 *   to `costUsd` and `toolCostUsd`: `total` takes their `costUsd`, and each `bySandbox`
 *   entry's cost also goes to the thread that wrote the `sandbox` event with that `name`. They
 *   are not model calls, so `calls` stays the model calls that reported usage. Calls whose
 *   cost is unknown (`unknownCostCalls`) add no dollars and are counted apart.
 * - A worker or check thread belongs to the task its `thread.started` names, so a task's
 *   spend covers all its attempts: worker, check and any redo. A thread with no task (the root, the main
 *   agent) belongs to `main`.
 * - Wall time is per thread, the sum of its spans, each from a `thread.started` to the
 *   thread's first `thread.ended` after it (a later end, such as a cancel of finished work,
 *   adds nothing), or to the thread's latest event while it has none (running, or cut off
 *   by a crash). A resume opens a new span, so a thread's time is its whole working time, not
 *   its last stretch. A task's wall time is the sum over its threads. `main`'s and `total`'s
 *   are the root thread's, whose open span ends at the log's latest event: the run's own
 *   working time, across resumes. The root starting again means the runner restarted, so every
 *   open span ends there, each at its own latest event.
 * - Sandbox time is the time from a `bash` call to its result, `bash` being the one tool
 *   that runs in the sandbox; a call cut off by a restart counts nothing. The sandbox's
 *   bill is the uptime of all the run's sandboxes (`Run.usage.sandboxSeconds`), which is longer:
 *   each thread's sandbox idles between its calls.
 *
 * The runner's end-of-run log line sums the same model costs over the run's threads, so
 * without provider calls `total.costUsd` matches it for a run that didn't lose events.
 */
import type { RunEvent } from "./events";
import type { ProviderCalls } from "./run";
import { threadRole } from "./thread-role";

export type Spend = {
  /** Model calls plus paid tool calls, in US dollars. */
  costUsd: number;
  /** The paid tool calls' part of `costUsd`. */
  toolCostUsd: number;
  /** Paid tool calls cut off before their usage arrived: their cost is unknown, and not in `costUsd`. */
  unknownCostCalls: number;
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

export type ThreadSpend = {
  threadId: string;
  spend: Spend;
  /** Wall seconds of its spans before the one still open; all of `spend.wallSeconds` when none is open. */
  endedSeconds: number;
  /** When the span still open at the end of the log started; a live clock shows `endedSeconds` plus now minus this. */
  openSince: string | null;
};

export type RunSpend = {
  /** In the order the threads first started. */
  threads: ThreadSpend[];
  /** In the order the tasks' first threads started. */
  tasks: { taskId: string; spend: Spend }[];
  main: Spend;
  total: Spend;
};

const empty = (): Spend => ({
  costUsd: 0,
  toolCostUsd: 0,
  unknownCostCalls: 0,
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

const sum = (spends: Iterable<Spend>): Spend => {
  const out = empty();
  for (const s of spends) for (const k of Object.keys(out) as (keyof Spend)[]) out[k] += s[k];
  return out;
};

export function spend(events: readonly RunEvent[], providerCalls?: ProviderCalls): RunSpend {
  const total = empty();
  // threadId → its own spend and where it counts besides `total` (a task, `main`, or neither).
  const threads = new Map<string, Spend>();
  const owner = new Map<string, { task: string } | "main">();
  const ended = new Map<string, number>();
  const open = new Map<string, { since: number; last: number }>();
  // toolCallId → the `bash` call's thread and start.
  const bash = new Map<string, { threadId: string; at: number }>();
  // sandbox name → the thread that wrote its `sandbox` event.
  const sandboxOwner = new Map<string, string>();
  const openAtEnd = new Map<string, string>();
  let root: string | undefined;
  // The log's latest event time so far: the root thread's span ends there, since the root is
  // quiet while its workers run.
  let latest = Number.NEGATIVE_INFINITY;

  const seconds = (from: number, to: number) => Math.max(0, to - from) / 1000;
  const add = (threadId: string, f: (s: Spend) => void) => {
    f(total);
    const s = threads.get(threadId);
    if (s) f(s);
  };
  // Ends a thread's open span, the root's at the log's latest event and any other at its own,
  // and forgets its unanswered `bash` calls: a resume answers them with a repair result.
  // `last`: the log is over, so the span is still open for a live clock.
  const close = (threadId: string, at?: number, last = false) => {
    const span = open.get(threadId);
    if (span) {
      open.delete(threadId);
      const wall = seconds(span.since, at ?? (threadId === root ? latest : span.last));
      const s = threads.get(threadId);
      if (s) s.wallSeconds += wall;
      if (last) openAtEnd.set(threadId, new Date(span.since).toISOString());
      else ended.set(threadId, (ended.get(threadId) ?? 0) + wall);
    }
    for (const [id, call] of bash) if (call.threadId === threadId) bash.delete(id);
  };

  for (const e of events) {
    const at = Date.parse(e.createdAt);
    switch (e.type) {
      case "thread.started": {
        const { task } = e.payload;
        if (threadRole(e.payload) === "root") {
          // The root starts again only after the runner restarted, which cut off every thread.
          root = e.threadId;
          for (const threadId of [...open.keys()]) close(threadId);
        } else close(e.threadId);
        if (!owner.has(e.threadId)) {
          threads.set(e.threadId, empty());
          // A thread with a task is that task's; any other (the root, the main agent) is `main`'s.
          owner.set(e.threadId, task !== undefined ? { task } : "main");
        }
        open.set(e.threadId, { since: at, last: at });
        break;
      }
      case "thread.ended":
        close(e.threadId, at);
        break;
      case "message": {
        const used = e.payload.role === "assistant" ? e.payload.usage : undefined;
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
      case "sandbox":
        sandboxOwner.set(e.payload.name, e.threadId);
        break;
      case "tool.call":
        if (e.payload.name === "bash") bash.set(e.payload.toolCallId, { threadId: e.threadId, at });
        break;
      case "tool.result": {
        const call = bash.get(e.payload.toolCallId);
        bash.delete(e.payload.toolCallId);
        if (call) add(e.threadId, (s) => (s.sandboxSeconds += seconds(call.at, at)));
        break;
      }
    }
    const span = open.get(e.threadId);
    if (span) span.last = at;
    latest = Math.max(latest, at);
  }
  for (const threadId of [...open.keys()]) close(threadId, undefined, true);
  // The run's own working time is the root's; other threads of `main` add their calls, not time.
  if (root !== undefined) total.wallSeconds = threads.get(root)?.wallSeconds ?? 0;
  if (providerCalls) {
    total.costUsd += providerCalls.costUsd;
    total.toolCostUsd += providerCalls.costUsd;
    total.unknownCostCalls += providerCalls.unknownCostCalls;
    for (const { sandbox, costUsd, unknownCostCalls } of providerCalls.bySandbox) {
      const s = threads.get(sandboxOwner.get(sandbox) ?? "");
      if (s) {
        s.costUsd += costUsd;
        s.toolCostUsd += costUsd;
        s.unknownCostCalls += unknownCostCalls;
      }
    }
  }
  const tasks = new Map<string, Spend[]>();
  const mainThreads: Spend[] = [];
  for (const [threadId, s] of threads) {
    const o = owner.get(threadId);
    if (o === "main") mainThreads.push(s);
    else if (o) tasks.set(o.task, [...(tasks.get(o.task) ?? []), s]);
  }
  const main = sum(mainThreads);
  main.wallSeconds = total.wallSeconds;
  return {
    threads: [...threads].map(([threadId, s]) => ({
      threadId,
      spend: s,
      endedSeconds: ended.get(threadId) ?? 0,
      openSince: openAtEnd.get(threadId) ?? null,
    })),
    tasks: [...tasks].map(([taskId, spends]) => ({ taskId, spend: sum(spends) })),
    main,
    total,
  };
}
