/**
 * The `thread_message` tool: one thread talks to another thread of the same run. The
 * rules (steer or queue, `wait` only toward the caller's own children) are `Threads.message`'s;
 * the call and its result are `@voluma/contracts/thread-message`.
 */
import {
  type ThreadMessageResult,
  threadMessageInputSchema,
} from "@voluma/contracts/thread-message";
import type { Threads } from "../threads";
import type { Tool } from "./tool";

export function threadMessageTool(
  threads: Pick<Threads, "message">,
): Tool<typeof threadMessageInputSchema> {
  return {
    name: "thread_message",
    description:
      "Send a message to another thread of this run. A running thread receives it in its current turn; an idle one wakes up with it. " +
      "Set `wait` to block until the thread's next reply; that works only for threads you started.",
    input: threadMessageInputSchema,
    async execute({ threadId, text, wait }, ctx) {
      try {
        const result: ThreadMessageResult = await threads.message(
          ctx.threadId,
          threadId,
          text,
          wait === true,
        );
        return { output: JSON.stringify(result), isError: false, truncated: false };
      } catch (error) {
        return {
          output: String(error instanceof Error ? error.message : error),
          isError: true,
          truncated: false,
        };
      }
    },
  };
}
