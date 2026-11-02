/**
 * The `bash_manage` tool: looks at, waits for, stops or lets go of the thread's background
 * `bash` commands (`bash-runtime.ts`).
 */
import { z } from "zod";
import type { BashRuntime } from "../bash-runtime";
import type { Tool } from "./tool";

const inputSchema = z.object({
  action: z
    .enum(["list", "output", "wait", "kill", "detach"])
    .describe(
      "list: your background commands. output: the last output, or the result of an ended one. wait: until it ends (up to 10 minutes). kill: stop it. detach: let it run on without end notices or follow-up pings.",
    ),
  bash_id: z.string().optional().describe("The command's id; every action but list needs it."),
});

export function bashManageTool(runtime: BashRuntime): Tool<typeof inputSchema> {
  return {
    name: "bash_manage",
    description:
      "List, read, wait for, kill or detach the background commands you started with bash.",
    input: inputSchema,
    async execute({ action, bash_id }, ctx) {
      const { output, isError } = await runtime.manage(ctx.threadId, action, bash_id, ctx.signal);
      return { output, isError, truncated: false };
    },
  };
}
