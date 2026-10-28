/**
 * The `thread_message` tool: one thread talks to another thread of the same run. What a
 * message does (steer a running thread, wake an idle one) is the supervisor's `message`;
 * the call and its result are `@voluma/contracts/thread-message`. `wait` is reserved: it
 * is allowed only toward threads the caller started, and no thread starts children yet, so
 * the tool refuses it.
 */
import {
  type ThreadMessageResult,
  threadMessageInputSchema,
} from "@voluma/contracts/thread-message";
import type { Tool } from "./tool";

export function threadMessageTool(
  message: (from: string, to: string, text: string) => Promise<ThreadMessageResult>,
): Tool<typeof threadMessageInputSchema> {
  return {
    name: "thread_message",
    description:
      "Send a message to another thread of this run. A running thread receives it in its current turn; an idle one wakes up with it.",
    input: threadMessageInputSchema,
    async execute({ threadId, text, wait }, ctx) {
      try {
        if (wait) throw new Error("wait is not available: no thread starts child threads yet");
        const result = await message(ctx.threadId, threadId, text);
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
