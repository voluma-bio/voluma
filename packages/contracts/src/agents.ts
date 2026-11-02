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
  endedTime: string;
  /** The turn's input came from main (the brief, or a message from main) and it said nothing since: `silent` if the turn ends so. */
  fromMain: boolean;
  spoke: boolean;
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
  /** Why the previous claim ended, from the latest `claim.started`. */
  after: ClaimEndReason | undefined;
  /** `tool.call`s by thread and call id (`callKey`), for rebuilding a cut-off tool's result. */
  calls: ThreadRecords<AgentRecord>["calls"];
  /** Who spoke last to the researcher: a person's message is unanswered while it follows main's last message to `researcher`. */
  hasUnansweredPerson: boolean;
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
      startedAt: -1,
      endedAt: prev?.endedAt ?? -1,
      closeAt: prev?.closeAt,
      closeBy: prev?.closeBy,
      endedTime: prev?.endedTime ?? "",
      fromMain: prev === undefined || (continues && prev.fromMain),
      spoke: continues ? prev.spoke : false,
      lastReport: prev?.lastReport,
    };
  });
  const messages: AgentLog["messages"] = new Map();
  const written = new Map<string, number>();
  const delivered = new Set<string>();
  const notices: Notice[] = [];
  const deliveries: { at: number }[] = [];
  const idByName = new Map<string, string>();
  let cursor: string | undefined;
  let rootId: string | undefined;
  let rootEnded = false;
  let rootStartAt = -1;
  let rootEndAt = -1;
  let after: ClaimEndReason | undefined;
  let main: AgentRecord | undefined;
  let personAt = -1;
  let answeredAt = -1;

  for (const [at, e] of events.entries()) {
    written.set(e.id, at);
    if (e.type === "thread.started" && e.payload.parentThreadId === null) {
      rootId = e.threadId;
      rootStartAt = at;
    }
    if (e.type === "thread.ended" && e.threadId === rootId) {
      rootEndAt = at;
      if (e.payload.status === "completed") rootEnded = true;
    }
    if (e.type === "claim.started") after = e.payload.after;
    if (e.type === "run.reopened") rootEnded = false;
    const before = fold.threads.get(e.threadId);
    const { record, firstEnd } = fold.apply(e);
    const name = record?.name ?? "";
    switch (e.type) {
      case "thread.started": {
        if (!record) break;
        record.startedAt = at;
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
        break;
      }
      case "thread.ended":
        if (!record) break;
        record.endedAt = at;
        record.endedTime = e.createdAt;
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
      case "person.message":
        personAt = at;
        break;
      case "message": {
        if (!record || e.payload.role !== "user") break;
        const { sender } = e.payload;
        if (sender.kind === "thread") {
          if (sender.messageId) delivered.add(sender.messageId);
          if (record.place === "worker" && fold.threads.get(sender.threadId)?.place === "main") {
            record.fromMain = true;
          }
        } else if (sender.kind === "runtime" && sender.covers) {
          delivered.add(sender.covers);
          if (record.place === "main") {
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
    after,
    calls: fold.calls,
    hasUnansweredPerson: personAt > answeredAt,
  };
  memo.set(events, { length: events.length, value });
  return value;
}

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
