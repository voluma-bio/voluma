/**
 * The `thread_message` tool: how one agent thread talks to another.
 *
 * Scope: the target must be a thread of the same run. `wait` is allowed only
 * toward the sender's own child threads, so two threads can't wait on each
 * other. The message can't change the target's model, tools or prompt. The
 * runtime enforces all three; these schemas only shape the call.
 *
 * It lives in contracts because the sender's tool and `message.sender` in
 * `events.ts` must agree, and both lanes read that event.
 *
 * Delivery: a running target receives it as a follow-up in its current turn;
 * an idle target queues it and wakes. It is stored as a new `message` event
 * on the target, with `sender` set, and never edited into history.
 */
import { z } from "zod";

const nonEmpty = z.string().min(1);

export const threadMessageInputSchema = z.object({
  threadId: nonEmpty.describe("The thread to message, in this run."),
  text: nonEmpty.describe("The message for the target thread."),
  /** Block until the target finishes its next reply; only for the sender's own children. */
  wait: z
    .boolean()
    .optional()
    .describe("Wait for the target's next reply. Allowed only for threads you started."),
});
export type ThreadMessageInput = z.infer<typeof threadMessageInputSchema>;

export const threadMessageResultSchema = z.object({
  /** `steered`: the target was running. `queued`: it was idle and is waking. */
  delivery: z.enum(["steered", "queued"]),
  /** The target's reply text; set only when `wait` was true. */
  reply: z.string().optional(),
});
export type ThreadMessageResult = z.infer<typeof threadMessageResultSchema>;
