/**
 * What the supervisor reads from the stored events besides `fold`: the worker and check
 * threads, their ends and wakes, the judgments recorded and the main thread's wakes. A pure function of the events,
 * so a resumed run derives what the first one did. It changes with the event schema; the
 * supervisor's policy lives in `supervisor.ts`.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { PayloadOf } from "./recorder";

export type Role = "worker" | "check";

/** A worker or check thread as the log shows it. */
export interface ThreadRecord {
  id: string;
  role: Role;
  taskId: string;
  /** How its latest invocation ended; undefined while the log shows it started and not ended. */
  end: PayloadOf<"thread.ended"> | undefined;
  /** Messages the runtime sent it to get it moving again. */
  wakes: number;
  /** How many times the log shows it started: the first run and each resume. */
  starts: number;
}

export interface ThreadLog {
  threads: Map<string, ThreadRecord>;
  /** Judgment events by the id of the thread whose end raised the point. */
  judgments: Map<string, PayloadOf<"judgment">>;
  /** The main thread's wakes by `<thread id>@<starts>` of the thread whose end raised them, in log order. */
  wakes: Map<string, PayloadOf<"wake">>;
  /** The notes block in force: the latest wake's `note`. */
  notes: string | undefined;
  ids: Set<string>;
}

export const JUDGMENT_SUFFIX = ":judgment";
export const WAKE_SUFFIX = ":wake";

// The log only grows, so its length says whether the derivation is current.
const memo = new WeakMap<readonly RunEvent[], { length: number; value: ThreadLog }>();

export function threadLog(events: readonly RunEvent[]): ThreadLog {
  const cached = memo.get(events);
  if (cached?.length === events.length) return cached.value;
  const value: ThreadLog = {
    threads: new Map(),
    judgments: new Map(),
    wakes: new Map(),
    notes: undefined,
    ids: new Set(),
  };
  for (const e of events) {
    value.ids.add(e.id);
    const record = value.threads.get(e.threadId);
    switch (e.type) {
      case "thread.started": {
        const { kind, task } = e.payload;
        if ((kind === "worker" || kind === "check") && task) {
          value.threads.set(e.threadId, {
            id: e.threadId,
            role: kind,
            taskId: task,
            end: undefined,
            wakes: record?.wakes ?? 0,
            starts: (record?.starts ?? 0) + 1,
          });
        }
        break;
      }
      case "thread.ended":
        if (record) record.end = e.payload;
        break;
      case "message":
        if (record && e.payload.role === "user" && e.payload.sender.kind === "runtime") {
          record.wakes++;
        }
        break;
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
  memo.set(events, { length: events.length, value });
  return value;
}

export const startedFor = (d: ThreadLog, taskId: string, role: Role) =>
  [...d.threads.values()].filter((r) => r.taskId === taskId && r.role === role);
