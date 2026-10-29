/**
 * What the supervisor reads from the stored events besides `fold`: the worker and check
 * threads, their ends and wakes, the judgments recorded and the main thread's wakes. A pure function of the events,
 * so a resumed run derives what the first one did. It changes with the event schema; the
 * supervisor's policy lives in `supervisor.ts`.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import type { PayloadOf } from "./recorder";

export type Role = "worker" | "check";

/** A worker or check thread as the log shows it. */
export interface ThreadRecord {
  id: string;
  role: Role;
  taskId: string;
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
}

export interface ThreadLog {
  threads: Map<string, ThreadRecord>;
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
    after: undefined,
    notes: undefined,
    ids: new Set(),
  };
  const briefed = new Set<string>(); // threads whose brief (first user message) the log holds
  // Threads started again while their latest start had no end: the message that follows is a
  // cut-off resume, not a wake (a wake is the runtime asking a thread that stopped).
  const resumedCutOff = new Set<string>();
  for (const e of events) {
    value.ids.add(e.id);
    const record = value.threads.get(e.threadId);
    switch (e.type) {
      case "claim.started":
        value.after = e.payload.after;
        break;
      case "thread.started": {
        const { kind, task } = e.payload;
        if ((kind === "worker" || kind === "check") && task) {
          if (record && !record.end) resumedCutOff.add(e.threadId);
          value.threads.set(e.threadId, {
            id: e.threadId,
            role: kind,
            taskId: task,
            end: undefined,
            wakes: record?.wakes ?? 0,
            starts: (record?.starts ?? 0) + 1,
            model: record?.model ?? e.payload.model,
            openCalls: record?.openCalls ?? new Map(),
          });
        }
        break;
      }
      case "thread.ended":
        if (record) record.end = e.payload;
        break;
      case "tool.call":
        record?.openCalls.set(e.payload.toolCallId, e.payload.name);
        break;
      case "tool.result":
        record?.openCalls.delete(e.payload.toolCallId);
        break;
      case "message":
        if (record && e.payload.role === "user" && e.payload.sender.kind === "runtime") {
          const afterCutOff = resumedCutOff.delete(e.threadId);
          if (briefed.has(e.threadId) && !afterCutOff) record.wakes++;
          briefed.add(e.threadId);
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
