/**
 * The supervisor's one judgment seam. Routine wakes are code (`supervisor.ts`); a check that
 * disagrees, or a thread that failed in a way the code doesn't recognise, goes through
 * `Judgment.decide`, and whatever it writes records `by: judgment(arm)`. The arms are what
 * the experiment compares (see the work item's supervisor-judgment decision); `llmJudgment`
 * is the first: one structured call to a model, fresh for each decision.
 */
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { z } from "zod";

export type JudgmentPoint =
  | {
      kind: "check-disagreed";
      taskId: string;
      /** The task as the fold shows it: status, reason, milestones, open items. */
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

export interface Judgment {
  /** Names the implementation in the record (`by: judgment(arm)`). */
  arm: string;
  decide(point: JudgmentPoint): Promise<Decision>;
}

const SYSTEM = `You are the supervisor of an analysis run. A task of the run needs a decision.
Reply with one JSON object and nothing else: {"action": "accept" | "redo" | "fail", "reason": "<one plain sentence>"}.
- accept: leave the task for a person to look at. Choose this when the work is plausible or the doubt is small.
- redo: a worker should do the task again. Choose this only when the report shows a concrete mistake a second attempt could fix.
- fail: the task cannot be done.`;

/** `complete` is one model call, e.g. `(c) => models.completeSimple(model, c, { apiKey })`. */
export function llmJudgment(
  arm: string,
  complete: (context: Context) => Promise<AssistantMessage>,
): Judgment {
  return {
    arm,
    async decide(point) {
      const question =
        point.kind === "check-disagreed"
          ? `The second agent that checked task ${point.taskId} did not pass it.`
          : `The thread working on task ${point.taskId} failed: ${point.error}`;
      const context: Context = {
        systemPrompt: SYSTEM,
        messages: [
          {
            role: "user",
            content: `${question}\n\nThe task as recorded:\n${JSON.stringify(point.report, null, 2)}`,
            timestamp: Date.now(),
          },
        ],
      };
      const reply = await complete(context);
      const text = reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error(`the judgment model answered without JSON: ${text.slice(0, 200)}`);
      return decisionSchema.parse(JSON.parse(json));
    },
  };
}
