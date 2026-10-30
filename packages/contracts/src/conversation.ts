/**
 * The chat between a researcher and a run's main agent (`messages.ts`), read from the run's
 * events: the panel calls `conversation` on what the run stream delivered (`GET
 * /api/run/runs/:id/stream`, the frames the run page already folds; `stream.ts`). The panel is
 * not built yet, so nothing calls it.
 */
import type { RunEvent } from "./events";
import type { Mark } from "./messages";

export type ConversationItem =
  | {
      from: "person";
      /** The `person.message` event id. */
      id: string;
      /** The id the panel sent with the message (`sendRunMessageRequestSchema.id`), the key of `runMessageSnapshotUrl`. */
      messageId: string;
      seq: number;
      at: string;
      text: string;
      marks: Mark[];
      /** The message has a view snapshot: `GET /api/review/runs/:runId/messages/:messageId/snapshot`. */
      hasSnapshot: boolean;
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
      const { text, marks, snapshotKey, taskId, go } = e.payload;
      const messageId = e.id.slice(e.id.indexOf(".person:") + ".person:".length);
      items.push({
        from: "person",
        id: e.id,
        messageId,
        seq: e.seq,
        at: e.createdAt,
        text: text ?? "",
        marks: marks ?? [],
        hasSnapshot: snapshotKey !== undefined,
        ...(taskId && { taskId }),
        go: go === true,
      });
    } else if (e.type === "reply") {
      items.push({ from: "agent", id: e.id, seq: e.seq, at: e.createdAt, text: e.payload.text });
    }
  }
  return items.sort((a, b) => a.seq - b.seq);
}
