/**
 * The chat between a researcher and a run's main agent (`messages.ts`), read from the run's
 * events: the panel and the API both call `conversation` on what the run stream delivered
 * (`GET /api/run/runs/:id/stream`, the frames the run page already folds; `stream.ts`), so
 * they cannot disagree about what was said.
 */
import type { RunEvent } from "./events";
import type { Mark, MessageSnapshotRef } from "./messages";

export type ConversationItem =
  | {
      from: "person";
      /** The `person.message` event id. */
      id: string;
      seq: number;
      at: string;
      text: string;
      marks: Mark[];
      snapshot?: MessageSnapshotRef;
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
    };

/** The person's messages and the agent's replies, in log order; every other event is skipped. */
export function conversation(events: readonly RunEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const e of events) {
    if (e.type === "person.message") {
      const { text, marks, snapshot, taskId, go } = e.payload;
      items.push({
        from: "person",
        id: e.id,
        seq: e.seq,
        at: e.createdAt,
        text: text ?? "",
        marks: marks ?? [],
        ...(snapshot && { snapshot }),
        ...(taskId && { taskId }),
        go: go === true,
      });
    } else if (e.type === "reply") {
      items.push({ from: "agent", id: e.id, seq: e.seq, at: e.createdAt, text: e.payload.text });
    }
  }
  return items.sort((a, b) => a.seq - b.seq);
}
