/**
 * The chat between a researcher and a run's main agent (`messages.ts`), read from the run's events:
 * the person's messages, the agent's replies (the task loop's `reply`, the agent loop's
 * `agent.message` to the researcher), how each correction ended (`corrections`, fold.ts), and on
 * the agent loop the calls main held for the researcher's yes (`approval.requested`) with their
 * answer and how each settled. A correction's end is the only sign in the chat that the AI
 * stopped working: its last reply is often "Redoing it now", and the outcome is in the root
 * thread's closing summary.
 */
import type { AcceptToCheckRequest, Attached } from "./agent-events";
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
      /** Agent-loop runs: the marks the message carried, as the API froze them. */
      attached: Attached[];
      /** Agent-loop runs: the output in view when they wrote. */
      output?: string;
      /** Agent-loop runs: the To check item the message answers. */
      toCheck?: AcceptToCheckRequest;
    }
  | {
      from: "agent";
      /** The `reply` or `agent.message` event id. */
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
    }
  | {
      /** A call main held for the researcher (agent-loop runs): the question, then its answer. */
      from: "approval";
      /** The `approval.requested` event id: what the answer route takes. */
      id: string;
      seq: number;
      at: string;
      tool: string;
      args: unknown;
      /** What the call would do, in words; written by code. */
      summary: string;
      /** The outputs it makes out of date if it runs, when the request names them. */
      outOfDate?: string[];
      /** The researcher's answer, once given. */
      answer?: { answer: "yes" | "no"; text?: string; at: string };
      /** How it closed: the held call ran, was refused when it ran, or was withdrawn. */
      settled?: { outcome: "done" | "refused" | "withdrawn"; at: string };
    };

/** The id of a held call's answer (`approval.given`, `approval.declined`) or its outcome (`approval.settled`). */
export const approvalIdOf = (requestId: string, of: "answer" | "settled") => `${requestId}:${of}`;

/**
 * The person's messages, the agent's replies, the corrections' ends and the held calls, in log
 * order (a held call where it was asked). A correction that completed with no go and a reply adds
 * nothing: the reply already answered.
 */
export function conversation(events: readonly RunEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  // A held call by the ids of its answer and its outcome.
  const approvals = new Map<string, Extract<ConversationItem, { from: "approval" }>>();
  for (const e of events) {
    if (e.type === "person.message") {
      const { text, marks, taskId, go, attached, output, toCheck } = e.payload;
      items.push({
        from: "person",
        id: e.id,
        seq: e.seq,
        at: e.createdAt,
        text: text ?? "",
        marks: marks ?? [],
        ...(taskId && { taskId }),
        go: go === true,
        attached: attached ?? [],
        ...(output && { output }),
        ...(toCheck && { toCheck }),
      });
    } else if (e.type === "approval.requested") {
      const { tool, args, summary, outOfDate } = e.payload;
      const item = {
        from: "approval" as const,
        id: e.id,
        seq: e.seq,
        at: e.createdAt,
        tool,
        args,
        summary,
        ...(outOfDate && { outOfDate }),
      };
      approvals.set(approvalIdOf(e.id, "answer"), item);
      approvals.set(approvalIdOf(e.id, "settled"), item);
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
