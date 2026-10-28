/**
 * The main thread's seam. The supervisor wakes it at task boundaries (`task-checked`) and
 * judgment points (`check-disagreed`, `thread-failed`); each wake is one model call that
 * answers with the notes block in force from then on and, at a judgment point, a decision.
 * `supervisor.ts` records every answer as a `wake` event before it applies it.
 *
 * The thread is append-only and keeps no state here: `ask` is given the wakes the log
 * holds, and rebuilds the conversation from them (a user message per wake, the recorded
 * answer as the reply), so a resumed run asks from the same context the first run had and
 * a provider's prompt cache keeps hitting the prefix. The context grows by one wake and
 * one answer per wake.
 */
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { WAKE_NOTE_MAX } from "@voluma/contracts/events";
import { z } from "zod";
import type { PayloadOf } from "./recorder";

export type WakePoint =
  | {
      kind: "task-checked";
      taskId: string;
      /** The task as the fold shows it: status, reason, milestones, open items. */
      report: unknown;
    }
  | {
      kind: "check-disagreed";
      taskId: string;
      report: unknown;
    }
  | {
      kind: "thread-failed";
      taskId: string;
      error: string;
      report: unknown;
    };

/** `accept`: leave the task for a person (to check). `redo`: mark it stale so a worker redoes it. `fail`: it can't be done. */
export const decisionSchema = z.object({
  action: z.enum(["accept", "redo", "fail"]),
  reason: z.string().min(1),
});
export type Decision = z.infer<typeof decisionSchema>;

/** An answer: the whole notes block (absent: leave the notes), and the decision a judgment point needs. */
export interface Reply {
  note?: string;
  decision?: Decision;
}
const replySchema = z.object({ note: z.string().optional(), decision: decisionSchema.optional() });

export type Wake = PayloadOf<"wake">;

export interface MainThread {
  /** The model as `provider/id`, which each `wake` records. */
  model: string;
  /** `signal` aborts at the supervisor's deadline or when the run is cancelled; stop then. */
  ask(point: WakePoint, past: readonly Wake[], signal: AbortSignal): Promise<Reply>;
}

const MAIN = `You are the main thread of an analysis run. A plan of tasks runs under a supervisor that decides what runs and when; you never choose that. A worker agent does each task and a second agent checks it. The supervisor wakes you with one message at a time: a task was checked, a check did not pass, or a worker failed.
Reply to every message with one JSON object and nothing else: {"note": "<notes>", "decision": {"action": "accept" | "redo" | "fail", "reason": "<one plain sentence>"}}.
- note: the notes that go into the prompt of every worker and checker that starts after this message. Rewrite the whole block each time, under ${WAKE_NOTE_MAX / 2} characters, from your last note and what you just learned: facts settled so far, disagreements already resolved and why, items open for a person, and for each task what the next worker must not redo or contradict. Cite files; do not copy numbers a file holds. Leave "note" out to keep your last one.
- decision: only when the message asks for one, never otherwise. accept leaves the task for a person to look at (choose it when the work is plausible or the doubt is small); redo has a worker do the task again (only when the report shows a concrete mistake a second attempt can fix); fail means the task cannot be done.`;

export const mainSystem = (...parts: (string | undefined)[]) =>
  [...parts, MAIN].filter((p): p is string => !!p).join("\n\n");

/** The point as the `wake` event records it. */
export function pointOf({ kind, taskId, ...input }: WakePoint) {
  return { kind, taskId, input };
}

function wakeText(point: Wake["point"]): string {
  const what =
    point.kind === "run-started"
      ? "The run is starting."
      : point.kind === "task-checked"
        ? `Task ${point.taskId} was checked.`
        : point.kind === "check-disagreed"
          ? `The second agent that checked task ${point.taskId} did not pass it. A decision is needed.`
          : `The thread working on task ${point.taskId} failed. A decision is needed.`;
  return `${what}\n${JSON.stringify(point.input)}`;
}

/** The conversation so far: each wake the log holds and its recorded answer, then the new wake. */
function conversation(model: Model<Api>, past: readonly Wake[], point: Wake["point"]): Message[] {
  const messages: Message[] = [];
  const at = Date.now();
  for (const w of past) {
    if (w.error !== undefined) continue;
    messages.push({ role: "user", content: wakeText(w.point), timestamp: at });
    const answer = { ...(w.note !== undefined && { note: w.note }), decision: w.decision };
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(answer) }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: at,
    });
  }
  messages.push({ role: "user", content: wakeText(point), timestamp: at });
  return messages;
}

/**
 * `complete` is one model call, e.g. `(c, signal) => models.completeSimple(model, c, { apiKey, signal })`.
 * `system` is fixed for the run: a changed one would miss the cache and change what resume asks.
 */
export function llmMainThread(
  model: Model<Api>,
  system: string,
  complete: (context: Context, signal: AbortSignal) => Promise<AssistantMessage>,
): MainThread {
  return {
    model: `${model.provider}/${model.id}`,
    async ask(point, past, signal) {
      const reply = await complete(
        { systemPrompt: system, messages: conversation(model, past, pointOf(point)) },
        signal,
      );
      const text = reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error(`the main thread answered without JSON: ${text.slice(0, 200)}`);
      const answer = replySchema.parse(JSON.parse(json));
      const judged = point.kind !== "task-checked";
      if (judged && !answer.decision) {
        throw new Error("the main thread gave no decision at a judgment point");
      }
      return {
        note: answer.note?.slice(0, WAKE_NOTE_MAX),
        decision: judged ? answer.decision : undefined,
      };
    },
  };
}
