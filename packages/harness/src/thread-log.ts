/**
 * The one place the run loop reads the stored events besides `fold`, which it runs once and
 * hands on as `view`: every thread's state, brief, summary and unsent feedback, who holds each
 * task (the fold's current attempt), the asks and their answers, fix rounds, the calls a
 * rebuilt result needs, and what main has been told (delivery cursor, notices after it). A
 * pure function of the events, so a resumed run derives what the first one did. It changes
 * with the event schema; the policy lives in the run loop.
 *
 * A thread is in one state (`threadState`): running (the caller says so: only it knows the
 * process), idle (its latest invocation ended completed or failed; a message resumes it),
 * stopped (that invocation ended cancelled; never resumed) or cut off (its latest start has
 * no end and it is not running). A stop appends the end first, so the log shows it at once.
 */
import type { RunEvent } from "@voluma/contracts/events";
import {
  abandonedEvents,
  type Correction,
  corrections,
  type Folded,
  fold,
} from "@voluma/contracts/fold";
import type { Mark } from "@voluma/contracts/messages";
import type { EvidenceRef } from "@voluma/contracts/output";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import { threadPlace } from "@voluma/contracts/thread-place";
import type { UserSender } from "./adapters/pi/start-thread";
import type { PayloadOf } from "./recorder";
import { callKey, effectId } from "./tools/effects";

/** The sandbox path of a file a task names: the inverse of `refOf` (`task-runtime.ts`). */
export const pathOf = (taskId: string, f: Pick<EvidenceRef, "root" | "path">): string =>
  f.root === "scratch" ? `/scratch/${f.path}` : `/outputs/${taskId}/${f.path}`;

/** The part of a verdict's checkpoint the main agent is told (`text` cut to this many characters). */
const VERDICT_TEXT_MAX = 1500;

export type Role = "worker" | "check";

/** A worker's or check thread's question to the main agent, and the answer once it has one. */
export interface AskRecord {
  /** The `ask` event's id. */
  id: string;
  question: string;
  answer: { id: string; text: string; files: { root: string; path: string }[] } | undefined;
}

export type ThreadState = "running" | "idle" | "stopped" | "cut-off";

/** A worker, check or main thread as the log shows it. */
export type TaskThread = ThreadFields & { place: Role; taskId: string };
export type ThreadRecord = TaskThread | (ThreadFields & { place: "main"; taskId?: undefined });

/** Who a thread is: what its layout and start need, whether it is a logged record or a thread about to start. */
export type ThreadIdentity = { id: string; role: string; name: string } & (
  | { place: "main"; taskId?: undefined }
  | { place: Role; taskId: string }
);

interface ThreadFields {
  id: string;
  /** The role file the thread runs on (`thread.started`'s `kind`): the facts that decide its sandbox, tools and checker. */
  role: string;
  /** The id without the run id (`main.2`, `segmentation.worker`): its sandbox's name and its folder under `/scratch`. */
  name: string;
  /** How its latest invocation ended; undefined while the log shows it started and not ended. */
  end: PayloadOf<"thread.ended"> | undefined;
  /** Messages the runtime sent it to get it moving again (its brief, the first, is not one). */
  nudges: number;
  /** The main agent's `start_agent` brief, for a worker. */
  brief: string;
  /** The latest checkpoint summary it wrote. */
  lastSummary: string | undefined;
  /** Feedback that opened its latest attempt and has not reached it yet (a cut between the two writes). */
  pendingFeedback: { text: string; from: string } | undefined;
  /** How many times the log shows it started: the first run and each resume. */
  starts: number;
  /** How the invocation before its latest ended, when that invocation wrote an end (a cut-off writes none). */
  endBefore: PayloadOf<"thread.ended"> | undefined;
  /**
   * The model made a reply (an assistant message or a tool call) since its latest start. A reply
   * that the thread's failed end follows is not one: it is the failure.
   */
  replied: boolean;
  /** `replied` as it was before the latest assistant message. */
  repliedBefore: boolean;
  /** The model it started on (`provider/id`); a resume keeps it. Absent: not recorded. */
  model: string | undefined;
  /** Tool calls the log shows without a result, by tool call id; after a cut-off, what it was cut off in. */
  openCalls: Map<string, string>;
  /** The questions a worker or check thread asked, in order. */
  asks: AskRecord[];
  /** The text of its latest reply in the latest invocation. */
  reply: string;
  /** Log positions of the latest answer to one of its asks and of the latest message another thread sent it. */
  answeredAt: number | undefined;
  heardAt: number | undefined;
  /**
   * The input its latest start was given, while no user message follows that start: a cut
   * between the start and the first message. The next resume gives it again.
   */
  inputPending: { text: string; sender: UserSender } | undefined;
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
  /** That thread's name, which is how the main agent knows it. */
  threadName: string;
  taskId?: string;
} & (
  | { kind: "submitted" }
  /** A worker's turn ended without submitting; `reply` is what it said last. */
  | { kind: "worker-idle"; reply: string }
  | { kind: "failed"; error: string; place: "worker" | "check" }
  /** `rule` says how the check ended (`check-result`, `fix-limit`; `check-limit` only in runs from when checks were time-limited). */
  | {
      kind: "check-result";
      rule: string;
      verdict?: "passed" | "needs-review";
      summary?: string;
      text?: string;
    }
  /** A check thread waits for the answer; a worker carries on. */
  | { kind: "ask"; question: string; place: "worker" | "check" }
  | { kind: "stale"; reason: string }
  /** The loop stopped a thread the main agent did not ask to stop; `reason` says why. */
  | { kind: "stopped"; reason: string }
  /**
   * A correction ended unfinished (`correction.ended`): its task-state events and the files it
   * wrote are discarded. `taskId` is the task of its go, if it had one.
   */
  | { kind: "correction-ended"; status: "failed" | "cancelled"; error?: string }
  /**
   * The researcher wrote (`person.message`); `eventId` is the message's. A mark names a volume
   * block (`<taskId>/<outputId>`); `file` is that output's sandbox path, when the log has it.
   * `snapshot` is the sandbox path of the view snapshot.
   */
  | {
      kind: "person";
      text: string;
      marks: (Mark & { file?: string })[];
      snapshot?: string;
      /** The message carries a go (`taskId` names its task). */
      go?: true;
      /** How its correction closed (`corrections`): `abandoned` withdraws the message and its go. */
      closed: Correction["closed"];
    }
);

type NoticeBody = Notice extends infer N
  ? N extends unknown
    ? Omit<N, "at" | "threadName">
    : never
  : never;

/** A call of the main agent that a rebuilt result reads back (`calls`). */
export type MainCall =
  | { name: "start_worker" | "start_agent"; brief: string }
  | { name: "message"; threadId: string; text: string };

/** The stored input of a main-agent call; undefined for other tools or an input of another shape. */
function mainCall(name: string, input: unknown): MainCall | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const i = input as Record<string, unknown>;
  if ((name === "start_worker" || name === "start_agent") && typeof i.brief === "string")
    return { name, brief: i.brief };
  if (name === "message" && typeof i.threadId === "string" && typeof i.text === "string") {
    return { name, threadId: i.threadId, text: i.text };
  }
  return undefined;
}

/**
 * The thread a model's input names: its name (`segmentation.worker`), which is all a model is
 * shown, or an exact stored id (a thread started before names were what models see).
 */
export function threadByRef(
  threads: ReadonlyMap<string, ThreadRecord>,
  ref: string,
): ThreadRecord | undefined {
  return threads.get(ref) ?? [...threads.values()].find((r) => r.name === ref);
}

/**
 * An ask as a model sees it: `<checker name>:<tool call id>`, not the stored event id, which
 * starts with the checker's uuid.
 */
export const askRef = (name: string, threadId: string, askId: string) =>
  `${name}:${askId.slice(threadId.length + 1).replace(/:ask$/, "")}`;

export interface ThreadLog {
  /** `fold` of the same events. */
  view: Folded;
  threads: Map<string, ThreadRecord>;
  /** The latest main thread. */
  main: string | undefined;
  /** The thread that opened each task's current attempt (the fold's worker), unless that thread is stopped. */
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
  /** Why the previous claim ended, from the latest `claim.started`; undefined on a run's first claim. */
  after: ClaimEndReason | undefined;
  /** Scratch paths the main agent attached to answers, by the task of the check that asked. */
  answeredScratch: Map<string, Set<string>>;
  /** Every stored event by id: what it is, where it sits in the log, its thread, and the task of an attempt. */
  written: Map<string, { at: number; type: RunEvent["type"]; threadId: string; taskId?: string }>;
  /** The main agent's `start_agent` and `message` calls, by `callKey`. */
  calls: Map<string, MainCall>;
  /** Messages one thread sent another, as the target's user messages show them. */
  relayed: { from: string; to: string; text: string }[];
  /** The root thread (kind `supervisor`) and whether it has a completed end, ever and since its latest start. */
  root: { id: string | undefined; ended: boolean; endedThisClaim: boolean };
  /**
   * A researcher's message reopened the finished run (`run.reopened`) and the run has not ended
   * since: this is a correction, and the main agent's work tools wait for a go.
   */
  correcting: boolean;
  /** A reopen was stored after the latest `claim.started`: the next claim says it follows a reopen. */
  reopenPending: boolean;
  /** The open correction's go the main agent was told of (`corrections`): the task to redo and whether its redo began. */
  go: { taskId: string; redone: boolean } | undefined;
  /** A `person.message` has no `reply` yet. */
  unanswered: boolean;
}

/**
 * Whether a task has used its fix rounds: no more feedback or workers, unless an upstream
 * correction reset it. `pending` counts a `needs-review` result about to be written.
 */
export const fixLimitReached = (d: ThreadLog, taskId: string, max: number, pending = 0) =>
  (d.fixRounds.get(taskId) ?? 0) + pending >= max &&
  d.view.tasks.find((t) => t.id === taskId)?.status !== "stale";

/** The brief the main agent gave a worker, read back from its `start_agent` call. */
function briefOf(started: PayloadOf<"thread.started">, calls: ThreadLog["calls"]): string {
  const call =
    started.spawnedBy && started.parentThreadId
      ? calls.get(callKey(started.parentThreadId, started.spawnedBy))
      : undefined;
  return call?.name === "start_worker" || call?.name === "start_agent" ? call.brief : "";
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
 * A started thread's name. Rows an old runner wrote during the deploy that added `name` lack it;
 * their name is the id without the run id. Delete with step 2 (`name` required), see
 * `packages/contracts/.context/TODO.md`.
 */
function threadNameOf(e: Extract<RunEvent, { type: "thread.started" }>): string {
  return e.payload.name ?? e.threadId.slice(e.runId.length + 1);
}

/** The question a worker or check thread has open: its latest ask, when unanswered. */
export const openAsk = (r: ThreadRecord): AskRecord | undefined => {
  const last = r.asks.at(-1);
  return last && !last.answer ? last : undefined;
};

// The log only grows, so its length says whether the derivation is current.
const memo = new WeakMap<readonly RunEvent[], { length: number; value: ThreadLog }>();

export function threadLog(events: readonly RunEvent[]): ThreadLog {
  const cached = memo.get(events);
  if (cached?.length === events.length) return cached.value;
  const value: ThreadLog = {
    view: fold(events),
    threads: new Map(),
    main: undefined,
    holders: new Map(),
    fixRounds: new Map(),
    notices: [],
    cursor: undefined,
    undelivered: [],
    emptyDeliveries: 0,
    after: undefined,
    answeredScratch: new Map(),
    written: new Map(),
    calls: new Map(),
    relayed: [],
    root: { id: undefined, ended: false, endedThisClaim: false },
    correcting: false,
    reopenPending: false,
    go: undefined,
    unanswered: false,
  };
  let unanswered = false;
  let claimAt = -1; // the latest claim.started
  const deliveries: { at: number; first: boolean }[] = [];
  const volumeFiles = new Map<string, string>(); // volume block id -> its file's sandbox path
  const briefed = new Set<string>(); // threads whose brief (first user message) the log holds
  // Threads started again while their latest start had no end: the message that follows is a
  // cut-off resume, not a nudge (a nudge is the runtime asking a thread that stopped).
  const resumedCutOff = new Set<string>();
  const feedbackOpens = new Map<string, { text: string; from: string }>(); // attempt id -> the `message` call that opens it
  const verdicts = new Map<
    string,
    { verdict: "passed" | "needs-review"; summary?: string; text: string }
  >(); // by attempt
  const notice = (n: NoticeBody, at: number) =>
    value.notices.push({
      ...n,
      at,
      threadName: value.threads.get(n.threadId)?.name ?? "",
    } as Notice);
  // The task-state events of a failed or cancelled correction never happened, as `fold` has it.
  const { spans, open } = corrections(events);
  const abandoned = abandonedEvents(events, spans);
  for (const [at, e] of events.entries()) {
    value.written.set(e.id, {
      at,
      type: e.type,
      threadId: e.threadId,
      ...(e.type === "attempt.opened" && { taskId: e.payload.taskId }),
    });
    if (abandoned.has(e.id)) continue;
    const record = value.threads.get(e.threadId);
    switch (e.type) {
      case "claim.started":
        value.after = e.payload.after;
        claimAt = at;
        break;
      case "correction.ended": {
        const span = spans.find((s) => s.to === at && s.closed === "abandoned");
        notice(
          {
            eventId: e.id,
            threadId: e.threadId,
            kind: "correction-ended",
            ...(span?.go && { taskId: span.go.taskId }),
            status: e.payload.status,
            ...(e.payload.error !== undefined && { error: e.payload.error }),
          },
          at,
        );
        break;
      }
      case "run.reopened":
        value.root.ended = false;
        break;
      case "person.message": {
        const { text, marks, snapshotKey, go, taskId } = e.payload;
        // A message with no span (sent while the run was live, before corrections) counts as open.
        const closed = spans.find((s) => s.message === e.id)?.closed ?? "open";
        if (closed !== "abandoned") unanswered = true;
        notice(
          {
            eventId: e.id,
            threadId: e.threadId,
            kind: "person",
            text: text ?? "",
            marks: (marks ?? []).map((m) => ({
              ...m,
              ...(volumeFiles.has(m.volumeId) && { file: volumeFiles.get(m.volumeId) }),
            })),
            ...(snapshotKey && { snapshot: `/scratch/${snapshotKey.split("/scratch/")[1]}` }),
            closed,
            ...(go && { go: true as const }),
            ...(taskId && { taskId }),
          },
          at,
        );
        break;
      }
      case "reply":
        unanswered = false;
        break;
      case "revision.started":
        if (open?.go?.markerAt === at) value.fixRounds.set(open.go.taskId, 0);
        break;
      case "output": {
        const { taskId, outputId, output } = e.payload;
        if (output.kind === "volume") {
          volumeFiles.set(`${taskId}/${outputId}`, pathOf(taskId, output.volume.file));
        }
        break;
      }
      case "thread.started": {
        const { kind, task } = e.payload;
        if (kind === "supervisor") {
          value.root = { id: e.threadId, ended: value.root.ended, endedThisClaim: false };
          break;
        }
        // What the thread is (its place in the run) comes from the fields of its start; `kind`
        // is the role file it runs on (`agent`), which says what it holds and may do.
        const known = threadPlace(e.payload);
        if (known === "root") break;
        // A cut-off start that was given an input is resumed with that input, not a cut-off line.
        if (record && !record.end && !record.inputPending) resumedCutOff.add(e.threadId);
        const fields: ThreadFields = {
          id: e.threadId,
          role: kind,
          name: threadNameOf(e),
          end: undefined,
          nudges: record?.nudges ?? 0,
          brief: record?.brief ?? briefOf(e.payload, value.calls),
          lastSummary: record?.lastSummary,
          pendingFeedback: record?.pendingFeedback,
          starts: (record?.starts ?? 0) + 1,
          endBefore: record?.end,
          replied: false,
          repliedBefore: false,
          model: record?.model ?? e.payload.model,
          openCalls: record?.openCalls ?? new Map(),
          asks: record?.asks ?? [],
          reply: "",
          answeredAt: record?.answeredAt,
          heardAt: record?.heardAt,
          inputPending: e.payload.input,
          submitted: false,
        };
        value.threads.set(
          e.threadId,
          known === "main"
            ? { ...fields, place: known }
            : { ...fields, place: known, taskId: task as string },
        );
        if (known === "main") value.main = e.threadId;
        break;
      }
      case "thread.ended": {
        if (e.threadId === value.root.id) {
          value.root.endedThisClaim = true;
          if (e.payload.status === "completed") {
            value.root.ended = true;
          }
        }
        if (!record) break;
        const first = !record.end;
        record.end = e.payload;
        if (e.payload.status === "failed") record.replied = record.repliedBefore;
        if (first && record.place !== "main") {
          const base = { eventId: e.id, threadId: e.threadId, taskId: record.taskId };
          if (e.payload.status === "failed") {
            notice(
              {
                ...base,
                kind: "failed",
                error: e.payload.error ?? "it failed",
                place: record.place,
              },
              at,
            );
          } else if (
            e.payload.status === "completed" &&
            record.place === "worker" &&
            !record.submitted
          ) {
            notice({ ...base, kind: "worker-idle", reply: record.reply }, at);
          } else if (e.payload.status === "cancelled" && e.payload.summary) {
            notice({ ...base, kind: "stopped", reason: e.payload.summary }, at);
          }
        }
        break;
      }
      case "tool.call": {
        const { toolCallId, name, input } = e.payload;
        record?.openCalls.set(toolCallId, name);
        if (record) record.replied = true;
        const call = mainCall(name, input);
        if (call) {
          value.calls.set(callKey(e.threadId, toolCallId), {
            ...call,
            ...(call.name === "message" && {
              threadId: threadByRef(value.threads, call.threadId)?.id ?? call.threadId,
            }),
          });
          if (call.name === "message") {
            feedbackOpens.set(effectId("message", e.threadId, toolCallId), {
              text: call.text,
              from: e.threadId,
            });
          }
        }
        break;
      }
      case "tool.result":
        record?.openCalls.delete(e.payload.toolCallId);
        break;
      case "message":
        if (record && e.payload.role === "user") record.inputPending = undefined;
        if (record && e.payload.role === "assistant" && !e.payload.compaction) {
          record.reply = e.payload.text;
          record.repliedBefore = record.replied;
          record.replied = true;
        }
        if (
          record &&
          e.payload.role === "user" &&
          e.payload.sender.kind === "runtime" &&
          !e.payload.sender.notice
        ) {
          const afterCutOff = resumedCutOff.delete(e.threadId);
          const first = !briefed.has(e.threadId);
          if (!first && !afterCutOff) record.nudges++;
          briefed.add(e.threadId);
          const { covers } = e.payload.sender;
          if (record.place === "main" && covers !== undefined) {
            value.cursor = covers;
            // A thread's first message is its brief, not a delivery: it does not count toward liveness.
            deliveries.push({ at: value.written.get(covers)?.at ?? -1, first });
          }
        }
        if (record && e.payload.role === "user" && e.payload.sender.kind === "thread") {
          const { threadId: from } = e.payload.sender;
          record.heardAt = at;
          value.relayed.push({ from, to: e.threadId, text: e.payload.text });
          if (record.pendingFeedback?.from === from) record.pendingFeedback = undefined;
        }
        break;
      case "attempt.opened":
        if (record) record.pendingFeedback = feedbackOpens.get(e.id);
        break;
      case "checkpoint": {
        const { verdict, summary, text } = e.payload;
        if (record && summary) record.lastSummary = summary;
        if (verdict && record?.place === "check") {
          verdicts.set(e.payload.attemptId, { verdict, ...(summary && { summary }), text });
        }
        break;
      }
      case "task": {
        const { taskId, attemptId, status, reason, by } = e.payload;
        const base = { eventId: e.id, threadId: e.threadId, taskId };
        if (status === "stale") value.fixRounds.set(taskId, 0);
        if (status === "under-review" && by.kind === "agent" && record) {
          record.submitted = true;
          if (record.place !== "main") notice({ ...base, kind: "submitted" }, at);
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
          notice(
            {
              ...base,
              kind: "check-result",
              rule: by.rule,
              ...(result && {
                verdict: result.verdict,
                ...(result.summary && { summary: result.summary }),
                text: result.text.slice(0, VERDICT_TEXT_MAX),
              }),
            },
            at,
          );
        }
        break;
      }
      case "ask": {
        record?.asks.push({ id: e.id, question: e.payload.question, answer: undefined });
        notice(
          {
            eventId: e.id,
            threadId: e.threadId,
            taskId: record?.taskId,
            kind: "ask",
            question: e.payload.question,
            place: record?.place === "worker" ? "worker" : "check",
          },
          at,
        );
        break;
      }
      case "answer": {
        const target = value.threads.get(e.payload.checkThreadId);
        if (target?.taskId) {
          const scratch = value.answeredScratch.get(target.taskId) ?? new Set<string>();
          for (const f of e.payload.files ?? []) if (f.root === "scratch") scratch.add(f.path);
          value.answeredScratch.set(target.taskId, scratch);
        }
        const ask = target?.asks.find((a) => a.id === e.payload.askId);
        if (target && ask && !ask.answer) {
          ask.answer = { id: e.id, text: e.payload.text, files: e.payload.files ?? [] };
          target.answeredAt = at;
        }
        break;
      }
    }
  }
  for (const t of value.view.tasks) {
    const worker = t.threads.worker;
    if (t.attemptId && worker && value.threads.get(worker)?.end?.status !== "cancelled") {
      value.holders.set(t.id, worker);
    }
  }
  // A thread that has started again since it failed (resumed by the loop or by main) is not
  // reported as failed.
  value.undelivered = value.notices.filter(
    (n) =>
      !deliveries.some((d) => n.at <= d.at) &&
      (n.kind !== "failed" || value.threads.get(n.threadId)?.end?.status === "failed"),
  );
  value.unanswered = unanswered;
  value.correcting = open !== undefined && !open.claimEnded;
  value.reopenPending = open !== undefined && claimAt < open.reopened;
  if (open?.go?.markerAt !== undefined)
    value.go = { taskId: open.go.taskId, redone: open.go.redone };
  let from = -1;
  const sizes = deliveries
    .filter((d) => !d.first)
    .map((d) => {
      const count = value.notices.filter((n) => n.at > from && n.at <= d.at).length;
      from = Math.max(from, d.at);
      return count;
    });
  value.emptyDeliveries = sizes.length - 1 - sizes.map((n) => n > 0).lastIndexOf(true);
  memo.set(events, { length: events.length, value });
  return value;
}

/**
 * A check that failed with no verdict while still its task's check: the main agent resumes it
 * (`message`) or replaces it (`stop_worker`), or the task is left to check (`run-loop.ts`).
 */
export const checkAwaitsMain = (d: ThreadLog, r: ThreadRecord): boolean => {
  if (r.place !== "check" || r.end?.status !== "failed") return false;
  const t = d.view.tasks.find((task) => task.id === r.taskId);
  return t?.status === "under-review" && t.threads.check === r.id && !t.checker?.verdict;
};

export const startedFor = (d: ThreadLog, taskId: string, place: Role) =>
  [...d.threads.values()].filter(
    (r): r is TaskThread => r.place !== "main" && r.taskId === taskId && r.place === place,
  );
