/**
 * The `bash` tool: runs a command in the thread's sandbox. The model sees the combined output
 * capped to its head and tail (`bash-output.ts`). A command still running after `timeout_min`
 * is not killed: it moves to the background (`bash-runtime.ts`) and its end reaches the thread
 * as a notice. Live chunks go to `ctx.output`, coalesced.
 */
import { z } from "zod";
import type { BashRuntime } from "../bash-runtime";
import type { ThreadLayout } from "../layout";
import type { Tool } from "./tool";

const inputSchema = z.object({
  command: z.string().min(1).describe("Shell command, run with bash -c."),
  timeout_min: z
    .number()
    .min(1)
    .max(59)
    .default(2)
    .describe(
      "Minutes to wait for the command. A command still running then keeps running in the background and is reported when it ends.",
    ),
  background: z
    .boolean()
    .optional()
    .describe("Start the command in the background at once and return without waiting."),
});

export function bashTool(layout: ThreadLayout, runtime: BashRuntime): Tool<typeof inputSchema> {
  return {
    name: "bash",
    description:
      "Run a shell command in the sandbox and return its combined stdout and stderr and exit code. " +
      "Long output is cut to its start and end; the full text is kept at the path the result names. " +
      "A command that outlives timeout_min is not killed: it moves to the background and its end is reported with a later tool result. " +
      "A background command keeps running while you are idle, and its end wakes you with a notice; closing stops it. " +
      "Use bash_manage to list, read, wait for, kill or detach background commands. " +
      `${layout.description}\nThere is no network.`,
    input: inputSchema,
    async execute({ command, timeout_min, background }, ctx) {
      const started = await runtime.start({
        threadId: ctx.threadId,
        toolCallId: ctx.toolCallId,
        command,
        timeoutMin: timeout_min,
        background: background === true,
        sandbox: await ctx.sandbox(),
        spillPath: layout.toolOutputPath(ctx.toolCallId),
        signal: ctx.signal,
        output: ctx.output,
      });
      if (started.kind === "backgrounded") {
        const how =
          started.reason === "asked"
            ? `${started.bashId}: started in the background.`
            : `Command exceeded timeout_min=${started.timeoutMin} and was backgrounded as ${started.bashId}.`;
        return {
          output: `${how} It keeps running, also while you are idle, and its end is reported to you; use bash_manage (list, output, wait, kill, detach) to look at it.`,
          isError: false,
          truncated: false,
        };
      }
      return {
        output: `${started.view.output}\n[exit code ${started.exit}]`,
        isError: started.exit !== 0,
        truncated: started.view.truncated,
      };
    },
  };
}
