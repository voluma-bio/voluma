/**
 * The chat between a researcher and a run's main agent (`messages.ts`), read from the run's events:
 * the person's messages, the agent's replies (`agent.message` to the researcher), how each
 * correction ended (`corrections.ts`), and the calls main held for the researcher's yes
 * (`approval.requested`) with their answer and how each settled. A correction's end is the only sign in the chat that the AI
 * stopped working: its last reply is often "Redoing it now", and the outcome is in the root
 * thread's closing summary.
 */
import type { AcceptToCheckRequest, Attached } from "./agent-events";
import { approvalAnswerId, approvalSettledId } from "./agents";
import { corrections } from "./corrections";
import type { RunEvent } from "./events";

export type ConversationItem =
  | {
      from: "person";
      /** The `person.message` event id. */
      id: string;
      seq: number;
      at: string;
      text: string;
      /** The marks the message carried, as the API froze them. */
      attached: Attached[];
      /** The output in view when they wrote. */
      output?: string;
      /** The To check item the message answers. */
      toCheck?: AcceptToCheckRequest;
    }
  | {
      from: "agent";
      /** The `agent.message` event id. */
      id: string;
      seq: number;
      at: string;
      text: string;
    }
  | {
      /** A correction ended: the AI is no longer working on the person's message. */
      from: "outcome";
      /** The event that ended it: the root's completed `thread.ended`, or `correction.ended`. */
      id: string;
      seq: number;
      at: string;
      /** `completed`: the claim finished. `failed` or `cancelled`: the claim did not. */
      status: "completed" | "failed" | "cancelled";
      /** The root's closing summary when completed; the reason, when one was recorded, when not. */
      text?: string;
    }
  | {
      /** A call main held for the researcher: the question, then its answer. */
      from: "approval";
      /** The `approval.requested` event id: what the answer route takes. */
      id: string;
      seq: number;
      at: string;
      tool: string;
      args: unknown;
      /** What the call would do, in words; written by code. */
      summary: string;
      /** The outputs it changes, when the request names them. */
      outputs?: string[];
      /** The outputs it makes out of date if it runs, when the request names them. */
      outOfDate?: string[];
      /** The researcher's answer, once given. */
      answer?: { answer: "yes" | "no"; text?: string; at: string };
      /** How it closed: the held call ran, was refused when it ran, or was withdrawn. */
      settled?: { outcome: "done" | "refused" | "withdrawn"; at: string };
    };

/**
 * The person's messages, the agent's replies, the corrections' ends and the held calls, in log
 * order (a held call where it was asked).
 */
export function conversation(events: readonly RunEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  // A held call by the ids of its answer and its outcome.
  const approvals = new Map<string, Extract<ConversationItem, { from: "approval" }>>();
  for (const e of events) {
    if (e.type === "person.message") {
      const { text, attached, output, toCheck } = e.payload;
      items.push({
        from: "person",
        id: e.id,
        seq: e.seq,
        at: e.createdAt,
        text: text ?? "",
        attached: attached ?? [],
        ...(output && { output }),
        ...(toCheck && { toCheck }),
      });
    } else if (e.type === "approval.requested") {
      const { tool, args, summary, outputs, outOfDate } = e.payload;
      const item = {
        from: "approval" as const,
        id: e.id,
        seq: e.seq,
        at: e.createdAt,
        tool,
        args,
        summary,
        ...(outputs && { outputs }),
        ...(outOfDate && { outOfDate }),
      };
      approvals.set(approvalAnswerId(e.id), item);
      approvals.set(approvalSettledId(e.id), item);
      items.push(item);
    } else if (e.type === "approval.given" || e.type === "approval.declined") {
      const request = approvals.get(e.id);
      if (request)
        request.answer = {
          answer: e.type === "approval.given" ? "yes" : "no",
          ...(e.payload.text && { text: e.payload.text }),
          at: e.createdAt,
        };
    } else if (e.type === "approval.settled") {
      const request = approvals.get(e.id);
      // Its text is written for main, not the researcher.
      if (request) request.settled = { outcome: e.payload.outcome, at: e.createdAt };
    } else if (e.type === "agent.message" && e.payload.to === "researcher") {
      items.push({ from: "agent", id: e.id, seq: e.seq, at: e.createdAt, text: e.payload.text });
    }
  }
  for (const span of corrections(events)) {
    const end = span.closed === "abandoned" ? events[span.to] : undefined;
    if (end?.type === "correction.ended") {
      const { status, error } = end.payload;
      items.push({
        from: "outcome",
        id: end.id,
        seq: end.seq,
        at: end.createdAt,
        status,
        ...(error && { text: error }),
      });
    } else if (span.claimEndedAt !== undefined) {
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
      });
    }
  }
  return items.sort((a, b) => a.seq - b.seq);
}
