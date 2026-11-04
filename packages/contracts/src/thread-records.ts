/**
 * What the run loop reads of a thread from the log: starts, how
 * the latest invocation ended, whether the model replied, the tool calls without a result, the
 * latest reply, and the input a cut-off start still owes. `threadRecords` folds the events into
 * these records; `agents.ts` adds its own fields to each record through `extend` and its own
 * reactions to each event after `apply`. Pure: process facts (which threads run) are the caller's.
 */
import type { RunEvent } from "./events";
import { type ThreadPlace, threadPlace } from "./thread-place";

type Payload<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>["payload"];
export type ThreadEnd = Payload<"thread.ended">;
type Started = Payload<"thread.started">;
export type UserSender = Extract<Payload<"message">, { role: "user" }>["sender"];

/** The key of a tool call in a map of calls: ids may repeat across threads. */
export const callKey = (threadId: string, toolCallId: string) => `${threadId}:${toolCallId}`;

export interface ThreadBase {
  id: string;
  /** What the thread is in the run (`threadPlace`). */
  place: Exclude<ThreadPlace, "root">;
  /** The id without the run id (`main.2`, `corin`): its sandbox's name. */
  name: string;
  /** How its latest invocation ended; undefined while the log shows it started and not ended. */
  end: ThreadEnd | undefined;
  /** How many times the log shows it started: the first run and each resume. */
  starts: number;
  /** How the invocation before its latest ended, when that invocation wrote an end (a cut-off writes none). */
  endBefore: ThreadEnd | undefined;
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
  /** The text of its latest reply in the latest invocation. */
  reply: string;
  /**
   * The input its latest start was given, while no user message follows that start: a cut
   * between the start and the first message. The next resume gives it again.
   */
  inputPending: { text: string; sender: UserSender } | undefined;
}

/** A stored tool call, by `callKey`: the tools whose results a cut-off rebuilds read their input back from here. */
interface StoredCall {
  name: string;
  input: unknown;
}

export interface ThreadRecords<T extends ThreadBase> {
  threads: Map<string, T>;
  calls: Map<string, StoredCall>;
  /**
   * Folds one event into `threads` and `calls`. Returns the event's thread's record after the
   * fold (undefined for the root and an unknown thread), and for a `thread.ended` whether it
   * was the thread's first end since its latest start.
   */
  apply(e: RunEvent): { record: T | undefined; firstEnd: boolean };
}

/**
 * `extend` builds a record on each `thread.started` of a non-root thread: the shared fields are
 * given, `prev` is the thread's earlier record (its extra fields carry over a resume).
 */
export function threadRecords<T extends ThreadBase>(
  extend: (started: Started, base: ThreadBase, prev: T | undefined) => T,
): ThreadRecords<T> {
  const threads = new Map<string, T>();
  const calls = new Map<string, StoredCall>();
  return {
    threads,
    calls,
    apply(e) {
      const record = threads.get(e.threadId);
      switch (e.type) {
        case "thread.started": {
          const place = threadPlace(e.payload);
          if (place === "root") return { record: undefined, firstEnd: false };
          const base: ThreadBase = {
            id: e.threadId,
            place,
            name: e.payload.name,
            end: undefined,
            starts: (record?.starts ?? 0) + 1,
            endBefore: record?.end,
            replied: false,
            repliedBefore: false,
            model: record?.model ?? e.payload.model,
            openCalls: record?.openCalls ?? new Map(),
            reply: "",
            inputPending: e.payload.input,
          };
          const next = extend(e.payload, base, record);
          threads.set(e.threadId, next);
          return { record: next, firstEnd: false };
        }
        case "thread.ended": {
          if (!record) return { record, firstEnd: false };
          const firstEnd = !record.end;
          record.end = e.payload;
          if (e.payload.status === "failed") record.replied = record.repliedBefore;
          return { record, firstEnd };
        }
        case "tool.call": {
          calls.set(callKey(e.threadId, e.payload.toolCallId), {
            name: e.payload.name,
            input: e.payload.input,
          });
          if (record) {
            record.openCalls.set(e.payload.toolCallId, e.payload.name);
            record.replied = true;
          }
          return { record, firstEnd: false };
        }
        case "tool.result":
          record?.openCalls.delete(e.payload.toolCallId);
          return { record, firstEnd: false };
        case "message":
          if (record && e.payload.role === "user") record.inputPending = undefined;
          if (record && e.payload.role === "assistant" && !e.payload.compaction) {
            record.reply = e.payload.text;
            record.repliedBefore = record.replied;
            record.replied = true;
          }
          return { record, firstEnd: false };
        default:
          return { record, firstEnd: false };
      }
    },
  };
}
