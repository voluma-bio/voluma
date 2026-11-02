/**
 * The agent model's run, read from its events: who the agents are, what each is doing, which
 * messages each has not received, and what main has not been told. Pure, so the runner's loop
 * and the API read the same answer; the one process fact, which threads run, is the caller's
 * (`agentState`). A thread carries no flag of its own: "closing", "closed" and "cut off" are
 * positions of events (`event-log.md`).
 *
 * Delivery has one rule: an item (a message to an agent, a wrap-up request) is delivered once a
 * stored user message, or the input of a stored thread start, carries its id: the thread
 * sender's `messageId`, or a runtime sender's `covers`. Nothing else says what an agent has read.
 */
import type { RunEvent } from "./events";
import type { PersonMessage } from "./messages";
import type { ClaimEndReason } from "./runner";
import { type ThreadBase, type ThreadRecords, threadRecords } from "./thread-records";

type Payload<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>["payload"];

export type AgentState = "working" | "idle" | "closing" | "closed" | "failed" | "cut-off";

export interface AgentRecord extends ThreadBase {
  /** `main` or `worker`; the agent model gives every thread one. */
  place: "main" | "worker";
  /** Log positions of its latest start and of its latest end (-1: none). */
  startedAt: number;
  endedAt: number;
  /** Position and author of the latest `close.requested` for it; undefined when none. */
  closeAt: number | undefined;
  closeBy: Payload<"close.requested">["by"] | undefined;
  /** The thread that started it and the tool call that did (a worker's brief and skills are read back from that call). */
  parentThreadId: string | null;
  spawnedBy: string | undefined;
  /** The closed worker it started from, and the worker it is blind to (names), from its first `thread.started`. */
  from: string | undefined;
  blind: string | undefined;
  endedTime: string;
  /** The turn's input came from main (the brief, or a message from main) and it said nothing since: `silent` if the turn ends so. */
  fromMain: boolean;
  spoke: boolean;
  /** When it last said what it is doing (`activity`), or else when it last started. */
  activityAt: number;
  /** Pings recorded since it last received a real input or made a tool call (0: none). */
  pings: number;
  /** When its latest turn that came from a real input ended: where its idle time counts from. */
  idleFrom: number;
  /** A recorded ping not yet delivered (id), until a delivery or any other input follows. */
  pendingPing: string | undefined;
  /** The later of `activityAt` and its latest tool result: when it last showed progress. */
  progressAt: number;
  /** Time in turn outside tool calls before `markAt`, since `activityAt`; `markAt` is 0 inside a tool call. */
  outsideMs: number;
  markAt: number;
  /** Its latest report: output id, version and the log position. */
  lastReport: { outputId: string; version: number; at: number } | undefined;
}

/** A message or wrap-up request an agent has not received. */
export type InboxItem =
  | { kind: "message"; id: string; at: number; from: string; text: string }
  | { kind: "wrap-up"; id: string; at: number; by: "main" | "ping" };

/** What main is told when it is next delivered to. `at` is the log position of the event behind it. */
export type Notice = { eventId: string; at: number; agent: string } & (
  | { kind: "output"; outputId: string; version: number }
  | { kind: "message"; text: string }
  | { kind: "failed"; error: string }
  | { kind: "closed"; note: string | undefined }
  /** A worker's turn ended with no report, message or close, after main's brief or message. */
  | { kind: "silent"; reply: string }
  /** The loop stopped a worker (it could not be resumed); `reason` says why. */
  | { kind: "stopped"; reason: string }
  /** The researcher wrote (`agent` is `researcher`); the payload is the stored message. */
  | { kind: "person"; message: PersonMessage }
  /** A held call ended without running as asked: declined by the researcher, refused, or withdrawn; or ran (`done`). `text` is their words or the tool's result. */
  | {
      kind: "approval";
      outcome: "done" | "declined" | "refused" | "withdrawn";
      toolCallId: string;
      text: string;
    }
);

export interface AgentLog {
  records: ThreadRecords<AgentRecord>["threads"];
  /** The latest main thread. */
  main: AgentRecord | undefined;
  /** `agent.message` events by id. */
  messages: Map<string, { at: number; from: string; to: string; text: string; time: string }>;
  /** Undelivered items per thread id, in log order. */
  inbox: Map<string, InboxItem[]>;
  /** Every notice, in log order; those after `cursor` are undelivered. */
  notices: Notice[];
  /** The id of the last event this fold read: what a delivery built from it covers. */
  lastEventId: string | undefined;
  /** The last event id the latest delivery to main accounted for. */
  cursor: string | undefined;
  undelivered: Notice[];
  /** Deliveries in a row, latest last, that carried no notice (the stuck rule counts them). */
  emptyDeliveries: number;
  /** Positions of every stored event by id. */
  written: Map<string, number>;
  /** The root's `completed` end is stored. */
  rootEnded: boolean;
  /** The root ended since its latest start (this claim's). */
  rootEndedThisClaim: boolean;
  /** Review: a `run.reopened` has no root `completed` end after it (`review.md`). */
  reviewing: boolean;
  /** The id of the latest `run.reopened`, else `run`: loop-written ids that can recur carry it, so one span's id is never found in the next. */
  span: string;
  /** Why the previous claim ended, from the latest `claim.started`. */
  after: ClaimEndReason | undefined;
  /** `tool.call`s by thread and call id (`callKey`), for rebuilding a cut-off tool's result. */
  calls: ThreadRecords<AgentRecord>["calls"];
  /** Who spoke last to the researcher: a person's message is unanswered while it follows main's last message to `researcher`. */
  hasUnansweredPerson: boolean;
}

/** Calls that say nothing was done, so a ping turn made of them is not an answer to the ping. */
const NOT_AN_ANSWER = ["activity", "read", "bash_manage"];

/** Minutes since the agent last showed progress (an activity line or a tool result); 0 while it is inside a tool call or not in a turn. */
export function stalledMinutes(r: AgentRecord, inTurn: boolean, now: number): number {
  return inTurn && r.openCalls.size === 0 ? Math.max(0, (now - r.progressAt) / 60_000) : 0;
}

/** Minutes of its turn outside tool calls since its last activity line: what the reminder counts. */
export function silentMinutes(r: AgentRecord, inTurn: boolean, now: number): number {
  const open = inTurn && r.openCalls.size === 0 ? Math.max(0, now - r.markAt) : 0;
  return (r.outsideMs + open) / 60_000;
}

const memo = new WeakMap<readonly RunEvent[], { length: number; value: AgentLog }>();

export function agentLog(events: readonly RunEvent[]): AgentLog {
  const cached = memo.get(events);
  if (cached?.length === events.length) return cached.value;

  const fold = threadRecords<AgentRecord>((started, base, prev) => {
    // A cut-off start continues the turn it resumes; any other start begins a new one.
    const continues = prev !== undefined && prev.end === undefined;
    return {
      ...base,
      place: base.place === "main" ? "main" : "worker",
      parentThreadId: started.parentThreadId,
      spawnedBy: prev?.spawnedBy ?? started.spawnedBy,
      from: prev?.from ?? started.from,
      blind: prev?.blind ?? started.blind,
      startedAt: -1,
      endedAt: prev?.endedAt ?? -1,
      closeAt: prev?.closeAt,
      closeBy: prev?.closeBy,
      endedTime: prev?.endedTime ?? "",
      fromMain: prev === undefined || (continues && prev.fromMain),
      spoke: continues ? prev.spoke : false,
      activityAt: 0,
      pings: prev?.pings ?? 0,
      idleFrom: prev?.idleFrom ?? 0,
      pendingPing: prev?.pendingPing,
      progressAt: 0,
      outsideMs: 0,
      markAt: 0,
      lastReport: prev?.lastReport,
    };
  });
  const messages: AgentLog["messages"] = new Map();
  const written = new Map<string, number>();
  const delivered = new Set<string>();
  const notices: Notice[] = [];
  const deliveries: { at: number }[] = [];
  const idByName = new Map<string, string>();
  const pingIds = new Set<string>();
  let cursor: string | undefined;
  let rootId: string | undefined;
  let rootEnded = false;
  let reviewing = false;
  let span = "run";
  let rootStartAt = -1;
  let rootEndAt = -1;
  let after: ClaimEndReason | undefined;
  let main: AgentRecord | undefined;
  let personAt = -1;
  let answeredAt = -1;

  /** An input reached `record`: a ping's own delivery clears the pending ping; any other input also restarts the count of pings in a row. */
  const receive = (record: AgentRecord, covers: string | undefined) => {
    if (covers !== undefined && pingIds.has(covers)) {
      if (record.pendingPing === covers) record.pendingPing = undefined;
      return;
    }
    record.pings = 0;
    record.pendingPing = undefined;
  };

  for (const [at, e] of events.entries()) {
    written.set(e.id, at);
    if (e.type === "thread.started" && e.payload.parentThreadId === null) {
      rootId = e.threadId;
      rootStartAt = at;
    }
    if (e.type === "thread.ended" && e.threadId === rootId) {
      rootEndAt = at;
      if (e.payload.status === "completed") {
        rootEnded = true;
        reviewing = false;
      }
    }
    if (e.type === "claim.started") after = e.payload.after;
    if (e.type === "run.reopened") {
      rootEnded = false;
      reviewing = true;
      span = e.id;
    }
    const before = fold.threads.get(e.threadId);
    const { record, firstEnd } = fold.apply(e);
    const name = record?.name ?? "";
    switch (e.type) {
      case "thread.started": {
        if (!record) break;
        record.startedAt = at;
        record.activityAt = record.progressAt = record.markAt = Date.parse(e.createdAt);
        record.outsideMs = 0;
        idByName.set(record.name, record.id);
        if (record.place === "main") {
          main = record;
          idByName.set("main", record.id);
        }
        // The input of a stored start is handed to the thread: the resume carries it.
        const sender = e.payload.input?.sender;
        // A new turn was begun by main when it is the brief or main's message; a cut-off resume continues the turn.
        if (before && before.end !== undefined) {
          record.fromMain =
            sender?.kind === "thread" && fold.threads.get(sender.threadId)?.place === "main";
        }
        if (sender?.kind === "thread" && sender.messageId) delivered.add(sender.messageId);
        if (sender?.kind === "runtime" && sender.covers) delivered.add(sender.covers);
        // A start that continues a cut-off turn received nothing new: the first start counted the input.
        if (e.payload.input && !(before && before.end === undefined))
          receive(record, sender?.kind === "runtime" ? sender.covers : undefined);
        break;
      }
      case "thread.ended":
        if (!record) break;
        record.endedAt = at;
        record.endedTime = e.createdAt;
        if (record.pings === 0) record.idleFrom = Date.parse(e.createdAt);
        if (record.place === "worker") {
          const { status, error, note, summary } = e.payload;
          if (status === "cancelled" && summary) {
            notices.push({ kind: "stopped", eventId: e.id, at, agent: name, reason: summary });
          } else if (status === "closed") {
            notices.push({ kind: "closed", eventId: e.id, at, agent: name, note });
          } else if (firstEnd && record.closeAt === undefined) {
            if (status === "failed") {
              notices.push({
                kind: "failed",
                eventId: e.id,
                at,
                agent: name,
                error: error ?? "it failed",
              });
            } else if (status === "completed" && record.fromMain && !record.spoke) {
              notices.push({ kind: "silent", eventId: e.id, at, agent: name, reply: record.reply });
            }
          }
        }
        break;
      case "agent.message": {
        const { from, to, text } = e.payload;
        messages.set(e.id, { at, from, to, text, time: e.createdAt });
        const sender = fold.threads.get(idOf(idByName, from));
        if (sender) sender.spoke = true;
        if (to === "main") {
          notices.push({ kind: "message", eventId: e.id, at, agent: from, text });
        }
        if (from === "main" && to === "researcher") answeredAt = at;
        break;
      }
      case "close.requested": {
        const target = fold.threads.get(e.payload.threadId);
        if (target) {
          target.closeAt = at;
          target.closeBy = e.payload.by;
          // A worker that closes itself has said its last word.
          if (e.payload.by === "self") target.spoke = true;
        }
        break;
      }
      case "output.published": {
        const { outputId, version } = e.payload;
        if (record) {
          record.spoke = true;
          record.lastReport = { outputId, version, at };
          if (record.place === "worker") {
            notices.push({ kind: "output", eventId: e.id, at, agent: name, outputId, version });
          }
        }
        break;
      }
      case "activity":
        if (record) {
          record.activityAt = record.progressAt = Date.parse(e.createdAt);
          record.outsideMs = 0;
        }
        break;
      case "tool.call":
        if (record) {
          if (record.markAt > 0) record.outsideMs += Date.parse(e.createdAt) - record.markAt;
          record.markAt = 0;
          // A ping turn that did work was answered: the next idle stretch starts from zero.
          if (!NOT_AN_ANSWER.includes(e.payload.name)) record.pings = 0;
        }
        break;
      case "tool.result":
        if (record) record.progressAt = record.markAt = Date.parse(e.createdAt);
        break;
      case "ping": {
        const target = fold.threads.get(e.payload.threadId);
        if (target) {
          target.pings += 1;
          target.pendingPing = e.id;
        }
        pingIds.add(e.id);
        break;
      }
      case "person.message":
        personAt = at;
        notices.push({
          kind: "person",
          eventId: e.id,
          at,
          agent: "researcher",
          message: e.payload,
        });
        break;
      case "approval.declined":
        notices.push({
          kind: "approval",
          eventId: e.id,
          at,
          agent: "researcher",
          outcome: "declined",
          toolCallId: e.payload.toolCallId,
          text: e.payload.text ?? "",
        });
        break;
      case "approval.settled":
        notices.push({
          kind: "approval",
          eventId: e.id,
          at,
          agent: "researcher",
          ...e.payload,
        });
        break;
      case "message": {
        if (!record || e.payload.role !== "user") break;
        const { sender } = e.payload;
        receive(record, sender.kind === "runtime" ? sender.covers : undefined);
        if (sender.kind === "thread") {
          if (sender.messageId) delivered.add(sender.messageId);
          if (record.place === "worker" && fold.threads.get(sender.threadId)?.place === "main") {
            record.fromMain = true;
          }
        } else if (sender.kind === "runtime" && sender.covers) {
          delivered.add(sender.covers);
          if (record.place === "main" && !pingIds.has(sender.covers)) {
            cursor = sender.covers;
            deliveries.push({ at: written.get(sender.covers) ?? -1 });
          }
        }
        break;
      }
    }
  }

  // Items not yet received. A closed or cancelled agent never will receive one (`closedUnread`).
  const inbox = new Map<string, InboxItem[]>();
  const add = (threadId: string, item: InboxItem) =>
    inbox.set(threadId, [...(inbox.get(threadId) ?? []), item]);
  const items: (InboxItem & { to: string })[] = [];
  for (const [id, m] of messages) {
    if (m.to === "researcher") continue;
    items.push({ kind: "message", id, at: m.at, from: m.from, text: m.text, to: m.to });
  }
  for (const r of fold.threads.values()) {
    if (r.closeAt !== undefined && r.closeBy !== "self") {
      const e = events[r.closeAt];
      if (e)
        items.push({
          kind: "wrap-up",
          id: e.id,
          at: r.closeAt,
          by: r.closeBy as "main" | "ping",
          to: r.name,
        });
    }
  }
  items.sort((a, b) => a.at - b.at);
  for (const { to, ...item } of items) {
    if (delivered.has(item.id)) continue;
    const target = fold.threads.get(idOf(idByName, to));
    // Main hears through deliveries (notices), not an inbox.
    if (target && target.place !== "main") add(target.id, item);
  }

  const cut = cursor === undefined ? -1 : (written.get(cursor) ?? -1);
  const undelivered = notices.filter((n) => n.at > cut);
  let from = -1;
  const sizes = deliveries.map((d) => {
    const count = notices.filter((n) => n.at > from && n.at <= d.at).length;
    from = Math.max(from, d.at);
    return count;
  });
  // The first delivery is main's opening brief (no `covers` accounts for notices before it).
  const empty = sizes.length - 1 - sizes.map((n) => n > 0).lastIndexOf(true);
  const value: AgentLog = {
    records: fold.threads,
    main,
    messages,
    inbox,
    notices,
    lastEventId: events.at(-1)?.id,
    cursor,
    undelivered,
    emptyDeliveries: empty,
    written,
    rootEnded,
    rootEndedThisClaim: rootEndAt > rootStartAt,
    reviewing,
    span,
    after,
    calls: fold.calls,
    hasUnansweredPerson: personAt > answeredAt,
  };
  memo.set(events, { length: events.length, value });
  return value;
}

/**
 * The ids of a held call's events, written once here. The request is `<thread>:approval:<toolCallId>`;
 * the researcher's answer (given or declined, so only one lands) is `<request>:answer`; the
 * runner's outcome is `<request>:settled`; an output left to the researcher after a declined
 * keep or redo is `<request>:left:<output>`.
 */
export const approvalRequestId = (threadId: string, toolCallId: string) =>
  `${threadId}:approval:${toolCallId}`;
export const approvalAnswerId = (requestId: string) => `${requestId}:answer`;
export const approvalSettledId = (requestId: string) => `${requestId}:settled`;
export const approvalLeftId = (requestId: string, outputId: string) =>
  `${requestId}:left:${outputId}`;

/** A held call and what became of it. `requestId` is the request event's id, the one the answer route takes. */
export type ApprovalRecord = Payload<"approval.requested"> & {
  requestId: string;
  /** The thread that made the call. */
  threadId: string;
  /** The researcher's answer (`<request id>:answer`), if given. */
  answer?: { kind: "given" | "declined"; text: string };
  /** `<request id>:settled` is stored. */
  settled: boolean;
};

const approvalMemo = new WeakMap<
  readonly RunEvent[],
  { length: number; value: ApprovalRecord[] }
>();

/** Every `approval.requested`, in log order, with its answer and whether it is settled. */
export function approvalRecords(events: readonly RunEvent[]): ApprovalRecord[] {
  const cached = approvalMemo.get(events);
  if (cached?.length === events.length) return cached.value;
  const value = foldApprovals(events);
  approvalMemo.set(events, { length: events.length, value });
  return value;
}

function foldApprovals(events: readonly RunEvent[]): ApprovalRecord[] {
  const answers = new Map<string, ApprovalRecord["answer"]>();
  const settled = new Set<string>();
  for (const e of events) {
    if (e.type === "approval.given" || e.type === "approval.declined")
      answers.set(e.id, {
        kind: e.type === "approval.given" ? "given" : "declined",
        text: e.payload.text ?? "",
      });
    else if (e.type === "approval.settled") settled.add(e.id);
  }
  return events.flatMap((e) =>
    e.type === "approval.requested"
      ? [
          {
            requestId: e.id,
            threadId: e.threadId,
            ...e.payload,
            ...(answers.has(approvalAnswerId(e.id)) && {
              answer: answers.get(approvalAnswerId(e.id)),
            }),
            settled: settled.has(approvalSettledId(e.id)),
          },
        ]
      : [],
  );
}

/** A held call the researcher has not answered and nothing has settled (a close withdraws it). */
export const openApprovals = (events: readonly RunEvent[]): ApprovalRecord[] =>
  approvalRecords(events).filter((a) => !a.answer && !a.settled);

/** Approved calls whose job has not settled: work in flight. */
export const givenApprovals = (events: readonly RunEvent[]): ApprovalRecord[] =>
  approvalRecords(events).filter((a) => a.answer?.kind === "given" && !a.settled);

const idOf = (idByName: Map<string, string>, name: string) => idByName.get(name) ?? "";

/**
 * Whether an agent is working, waiting, winding up, finished, failed or cut off. `running` is
 * the caller's: only it knows which threads this process runs.
 */
export function agentState(r: AgentRecord, running: boolean): AgentState {
  if (r.end?.status === "closed" || r.end?.status === "cancelled") return "closed";
  const closing = r.closeAt !== undefined;
  if (running) return closing ? "closing" : "working";
  if (r.end === undefined) return "cut-off";
  // A request after the latest end is a wrap-up not yet begun; a failure after it ended the wrap-up.
  if (closing && (r.closeAt as number) > r.endedAt) return "closing";
  if (r.end.status === "failed") return "failed";
  return closing ? "closing" : "idle";
}

/** Agents that count against the limit: every one but main that is not closed. */
export const openWorkers = (d: AgentLog, running: (id: string) => boolean): AgentRecord[] =>
  [...d.records.values()].filter(
    (r) => r.place === "worker" && agentState(r, running(r.id)) !== "closed",
  );
