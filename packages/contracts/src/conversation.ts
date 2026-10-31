/**
 * The chat between a researcher and a run's main agent (`messages.ts`), read from the run's events:
 * the person's messages, the agent's replies, and how each correction ended (`corrections`,
 * fold.ts). A correction's end is the only sign in the chat that the AI stopped working: its last
 * reply is often "Redoing it now", and the outcome is in the root thread's closing summary.
 */
import type { RunEvent } from "./events";
import { corrections } from "./fold";
import type { Mark } from "./messages";

export type ConversationItem =
  | {
      from: "person";
      /** The `person.message` event id. */
      id: string;
      seq: number;
      at: string;
      text: string;
      marks: Mark[];
      /** The task the person was reviewing when they wrote (or, with `go`, the task to redo). */
      taskId?: string;
      go: boolean;
    }
  | {
      from: "agent";
      /** The `reply` event id. */
      id: string;
      seq: number;
      at: string;
      text: string;
      /** The redo it proposes: the person accepts with a `go` on this task. */
      offer?: { taskId: string };
    }
  | {
      /** A correction ended: the AI is no longer working on the person's message. */
      from: "outcome";
      /** The event that ended it: the root's completed `thread.ended`, or `correction.ended`. */
      id: string;
      seq: number;
      at: string;
      /** `completed`: the claim finished. `failed` or `cancelled`: its task changes were undone. */
      status: "completed" | "failed" | "cancelled";
      /** The root's closing summary when completed; the reason, when one was recorded, when not. */
      text?: string;
      /**
       * The task the correction's go asked to redo; when completed, only if an attempt of it
       * opened (a go can end with the AI finding nothing to redo).
       */
      redo?: string;
    };

/**
 * The person's messages, the agent's replies and the corrections' ends, in log order. A correction
 * that completed with no go and a reply adds nothing: the reply already answered.
 */
export function conversation(events: readonly RunEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const e of events) {
    if (e.type === "person.message") {
      const { text, marks, taskId, go } = e.payload;
      items.push({
        from: "person",
        id: e.id,
        seq: e.seq,
        at: e.createdAt,
        text: text ?? "",
        marks: marks ?? [],
        ...(taskId && { taskId }),
        go: go === true,
      });
    } else if (e.type === "reply") {
      const { text, offer } = e.payload;
      items.push({
        from: "agent",
        id: e.id,
        seq: e.seq,
        at: e.createdAt,
        text,
        ...(offer && { offer }),
      });
    }
  }
  for (const span of corrections(events).spans) {
    const end = span.closed === "abandoned" ? events[span.to] : undefined;
    if (end?.type === "correction.ended") {
      const { status, error } = end.payload;
      const redo = span.go?.taskId;
      items.push({
        from: "outcome",
        id: end.id,
        seq: end.seq,
        at: end.createdAt,
        status,
        ...(error && { text: error }),
        ...(redo && { redo }),
      });
    } else if (span.claimEndedAt !== undefined && (span.go || !span.replied)) {
      // The root's completed end that finished the claim carries its summary.
      const root = events[span.claimEndedAt];
      if (root?.type !== "thread.ended") throw new Error("claimEndedAt is not a thread.ended");
      items.push({
        from: "outcome",
        id: root.id,
        seq: root.seq,
        at: root.createdAt,
        status: "completed",
        ...(root.payload.summary && { text: root.payload.summary }),
        ...(span.go?.redone && { redo: span.go.taskId }),
      });
    }
  }
  return items.sort((a, b) => a.seq - b.seq);
}

/**
 * The AI's offer still waiting on an answer: its latest reply, when that has an offer and no
 * message of the person's follows it. A correction's outcome after it leaves it open.
 */
export function openOffer(
  items: readonly ConversationItem[],
): Extract<ConversationItem, { from: "agent" }> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    if (m?.from === "outcome") continue;
    return m?.from === "agent" && m.offer ? m : undefined;
  }
  return undefined;
}
