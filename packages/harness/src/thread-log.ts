/**
 * What the run loop reads from the stored events besides `fold`: every thread's state, who
 * holds each task, the asks and their answers, fix rounds, and what main has been told
 * (delivery cursor, notices after it). A pure function of the events, so a resumed run derives
 * what the first one did. It changes with the event schema; the policy lives in the run loop.
 *
 * A thread is in one state (`threadState`): running (the caller says so: only it knows the
 * process), idle (its latest invocation ended completed or failed; a message resumes it),
 * stopped (that invocation ended cancelled; never resumed) or cut off (its latest start has
 * no end and it is not running). A stop appends the end first, so the log shows it at once.
 *
 * The wakes, judgments and notes of the old supervisor are still derived here until
 * `supervisor.ts` is deleted.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import type { PayloadOf } from "./recorder";

export type Role = "worker" | "check";

/** A check thread's question to the main agent, and the answer once it has one. */
export interface AskRecord {
  /** The `ask` event's id. */
  id: string;
  question: string;
  answer: { id: string; text: string } | undefined;
}

export type ThreadState = "running" | "idle" | "stopped" | "cut-off";

/** A worker, check or main thread as the log shows it. */
export type TaskThread = ThreadFields & { role: Role; taskId: string };
export type ThreadRecord = TaskThread | (ThreadFields & { role: "main"; taskId?: undefined });

interface ThreadFields {
  id: string;
  /** How its latest invocation ended; undefined while the log shows it started and not ended. */
  end: PayloadOf<"thread.ended"> | undefined;
  /** Messages the runtime sent it to get it moving again (its brief, the first, is not one). */
  wakes: number;
  /** How many times the log shows it started: the first run and each resume. */
  starts: number;
  /** The model it started on (`provider/id`); a resume keeps it. Absent: not recorded. */
  model: string | undefined;
  /** Tool calls the log shows without a result, by tool call id; after a cut-off, what it was cut off in. */
  openCalls: Map<string, string>;
  /** The questions a check thread asked, in order. */
  asks: AskRecord[];
  /** Milliseconds in finished invocations and answered asks; `activeMs` adds the open one. */
  closedMs: number;
  /** When the latest start began, while it has no end. */
  startedMs: number | undefined;
  /** When the oldest unanswered ask was asked. */
  waitingMs: number | undefined;
  /** The text of its latest reply in the latest invocation. */
  reply: string;
  /** It made a task `under-review` in the latest invocation. */
  submitted: boolean;
}

/** An event main must hear about; delivered once, by id (`ThreadLog.undelivered`). */
export type Notice = {
  /** The log event that raised it, and its position in the log. */
  eventId: string;
  at: number;
  /** The thread it is about. */
  threadId: string;
  taskId?: string;
} & (
  | { kind: "submitted" }
  /** A worker's turn ended without submitting; `reply` is what it said last. */
  | { kind: "worker-idle"; reply: string }
  | { kind: "failed"; error: string }
  /** `rule` says how the check ended (`check-result`, `check-limit`, `fix-limit`). */
  | { kind: "check-result"; rule: string; verdict?: "passed" | "needs-review"; summary?: string }
  | { kind: "ask"; question: string }
  | { kind: "stale"; reason: string }
);

type NoticeBody = Notice extends infer N ? (N extends unknown ? Omit<N, "at"> : never) : never;

export interface ThreadLog {
  threads: Map<string, ThreadRecord>;
  /** The latest main thread. */
  main: string | undefined;
  /** The thread that opened each task's current attempt, unless that thread is stopped. */
  holders: Map<string, string>;
  /** Per task: `needs-review` check results on its attempts since its latest stale mark. */
  fixRounds: Map<string, number>;
  /** Every notice, in log order. */
  notices: Notice[];
  /** The latest delivery to main: the id of the last event it accounted for. */
  cursor: string | undefined;
  /** Notices after the cursor. */
  undelivered: Notice[];
  /** How many of the latest deliveries in a row carried no notice. */
  emptyDeliveries: number;
  /** Judgment events by the id of the thread whose end raised the point. */
  judgments: Map<string, PayloadOf<"judgment">>;
  /** The main thread's wakes by `<thread id>@<starts>` of the thread whose end raised them, in log order. */
  wakes: Map<string, PayloadOf<"wake">>;
  /** Why the previous claim ended, from the latest `claim.started`; undefined on a run's first claim. */
  after: ClaimEndReason | undefined;
  /** The notes block in force: the latest wake's `note`. */
  notes: string | undefined;
  ids: Set<string>;
}

/** The state of a thread; undefined for an id the log has not seen start. */
export function threadState(
  r: ThreadRecord | undefined,
  running: boolean,
): ThreadState | undefined {
  if (!r) return undefined;
  if (running) return "running";
  if (!r.end) return "cut-off";
  return r.end.status === "cancelled" ? "stopped" : "idle";
}

/**
 * A thread's active time at `now`: finished invocations, plus the time since it began waiting
 * on an unanswered ask, or since its latest start if it is `running`. A cut-off invocation
 * counts nothing, so an outage does not eat a check's time.
 */
export function activeMs(r: ThreadRecord, now: number, running: boolean): number {
  const open = r.waitingMs ?? (running ? r.startedMs : undefined);
  return r.closedMs + (open === undefined ? 0 : Math.max(0, now - open));
}

/** The question a check thread waits on: its latest ask, when unanswered. */
export const openAsk = (r: ThreadRecord): AskRecord | undefined => {
  const last = r.asks.at(-1);
  return last && !last.answer ? last : undefined;
};

export const JUDGMENT_SUFFIX = ":judgment";
export const WAKE_SUFFIX = ":wake";

// The log only grows, so its length says whether the derivation is current.
const memo = new WeakMap<readonly RunEvent[], { length: number; value: ThreadLog }>();

export function threadLog(events: readonly RunEvent[]): ThreadLog {
  const cached = memo.get(events);
  if (cached?.length === events.length) return cached.value;
  const value: ThreadLog = {
    threads: new Map(),
    main: undefined,
    holders: new Map(),
    fixRounds: new Map(),
    notices: [],
    cursor: undefined,
    undelivered: [],
    emptyDeliveries: 0,
    judgments: new Map(),
    wakes: new Map(),
    after: undefined,
    notes: undefined,
    ids: new Set(),
  };
  const briefed = new Set<string>(); // threads whose brief (first user message) the log holds
  // Threads started again while their latest start had no end: the message that follows is a
  // cut-off resume, not a wake (a wake is the runtime asking a thread that stopped).
  const resumedCutOff = new Set<string>();
  const index = new Map<string, number>(); // event id -> position in the log
  const openers = new Map<string, string>(); // task -> thread that opened its current attempt
  const verdicts = new Map<string, { verdict: "passed" | "needs-review"; summary?: string }>(); // by attempt
  const deliveries: { at: number }[] = []; // positions of the events each delivery covered
  const notice = (n: NoticeBody, at: number) => value.notices.push({ ...n, at } as Notice);
  for (const [at, e] of events.entries()) {
    value.ids.add(e.id);
    index.set(e.id, at);
    const record = value.threads.get(e.threadId);
    const ms = Date.parse(e.createdAt);
    switch (e.type) {
      case "claim.started":
        value.after = e.payload.after;
        break;
      case "thread.started": {
        const { kind, task } = e.payload;
        const known =
          kind === "main" ? kind : (kind === "worker" || kind === "check") && task && kind;
        if (!known) break;
        if (record && !record.end) resumedCutOff.add(e.threadId);
        const fields: ThreadFields = {
          id: e.threadId,
          end: undefined,
          wakes: record?.wakes ?? 0,
          starts: (record?.starts ?? 0) + 1,
          model: record?.model ?? e.payload.model,
          openCalls: record?.openCalls ?? new Map(),
          asks: record?.asks ?? [],
          closedMs: record?.closedMs ?? 0,
          startedMs: ms,
          waitingMs: record?.waitingMs,
          reply: "",
          submitted: false,
        };
        value.threads.set(
          e.threadId,
          known === "main"
            ? { ...fields, role: known }
            : { ...fields, role: known, taskId: task as string },
        );
        if (known === "main") value.main = e.threadId;
        break;
      }
      case "thread.ended": {
        if (!record) break;
        const first = !record.end;
        record.end = e.payload;
        if (record.startedMs !== undefined) record.closedMs += ms - record.startedMs;
        record.startedMs = undefined;
        if (first && record.role !== "main") {
          const base = { eventId: e.id, threadId: e.threadId, taskId: record.taskId };
          if (e.payload.status === "failed") {
            notice({ ...base, kind: "failed", error: e.payload.error ?? "it failed" }, at);
          } else if (
            e.payload.status === "completed" &&
            record.role === "worker" &&
            !record.submitted
          ) {
            notice({ ...base, kind: "worker-idle", reply: record.reply }, at);
          }
        }
        break;
      }
      case "tool.call":
        record?.openCalls.set(e.payload.toolCallId, e.payload.name);
        break;
      case "tool.result":
        record?.openCalls.delete(e.payload.toolCallId);
        break;
      case "message":
        if (record && e.payload.role === "assistant") record.reply = e.payload.text;
        if (record && e.payload.role === "user" && e.payload.sender.kind === "runtime") {
          const afterCutOff = resumedCutOff.delete(e.threadId);
          if (briefed.has(e.threadId) && !afterCutOff) record.wakes++;
          briefed.add(e.threadId);
          const { covers } = e.payload.sender;
          if (record.role === "main" && covers !== undefined) {
            value.cursor = covers;
            deliveries.push({ at: index.get(covers) ?? -1 });
          }
        }
        break;
      case "attempt.opened":
        openers.set(e.payload.taskId, e.threadId);
        break;
      case "checkpoint": {
        const { verdict, summary } = e.payload;
        if (verdict && record?.role === "check") {
          verdicts.set(e.payload.attemptId, { verdict, ...(summary && { summary }) });
        }
        break;
      }
      case "task": {
        const { taskId, attemptId, status, reason, by } = e.payload;
        const base = { eventId: e.id, threadId: e.threadId, taskId };
        if (status === "stale") value.fixRounds.set(taskId, 0);
        if (status === "under-review" && by.kind === "agent" && record) {
          record.submitted = true;
          if (record.role !== "main") notice({ ...base, kind: "submitted" }, at);
        } else if (by.kind === "rule" && by.rule === "stale") {
          notice({ ...base, kind: "stale", reason }, at);
        } else if (
          by.kind === "rule" &&
          (by.rule === "check-result" || by.rule === "check-limit" || by.rule === "fix-limit")
        ) {
          const result = verdicts.get(attemptId);
          if (
            status === "to-check" &&
            result?.verdict === "needs-review" &&
            by.rule !== "check-limit"
          ) {
            value.fixRounds.set(taskId, (value.fixRounds.get(taskId) ?? 0) + 1);
          }
          notice({ ...base, kind: "check-result", rule: by.rule, ...result }, at);
        }
        break;
      }
      case "ask": {
        record?.asks.push({ id: e.id, question: e.payload.question, answer: undefined });
        if (record) record.waitingMs ??= ms;
        notice(
          {
            eventId: e.id,
            threadId: e.threadId,
            taskId: record?.taskId,
            kind: "ask",
            question: e.payload.question,
          },
          at,
        );
        break;
      }
      case "answer": {
        const target = value.threads.get(e.payload.checkThreadId);
        const ask = target?.asks.find((a) => a.id === e.payload.askId);
        if (target && ask && !ask.answer) {
          ask.answer = { id: e.id, text: e.payload.text };
          const next = target.asks.find((a) => !a.answer);
          if (target.waitingMs !== undefined) target.closedMs += ms - target.waitingMs;
          target.waitingMs = next ? ms : undefined;
        }
        break;
      }
      case "judgment":
        if (e.id.endsWith(JUDGMENT_SUFFIX)) {
          value.judgments.set(e.id.slice(0, -JUDGMENT_SUFFIX.length), e.payload);
        }
        break;
      case "wake":
        if (e.id.endsWith(WAKE_SUFFIX)) {
          value.wakes.set(e.id.slice(0, -WAKE_SUFFIX.length), e.payload);
          if (e.payload.note !== undefined) value.notes = e.payload.note;
        }
        break;
    }
  }
  for (const [taskId, thread] of openers) {
    if (value.threads.get(thread)?.end?.status !== "cancelled") value.holders.set(taskId, thread);
  }
  const cursorAt = value.cursor === undefined ? -1 : (index.get(value.cursor) ?? -1);
  value.undelivered = value.notices.filter((n) => n.at > cursorAt);
  let from = -1;
  const sizes = deliveries.map(({ at }) => {
    const count = value.notices.filter((n) => n.at > from && n.at <= at).length;
    from = Math.max(from, at);
    return count;
  });
  value.emptyDeliveries = sizes.length - 1 - sizes.map((n) => n > 0).lastIndexOf(true);
  memo.set(events, { length: events.length, value });
  return value;
}

export const startedFor = (d: ThreadLog, taskId: string, role: Role) =>
  [...d.threads.values()].filter(
    (r): r is TaskThread => r.role !== "main" && r.taskId === taskId && r.role === role,
  );
