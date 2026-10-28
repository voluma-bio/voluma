/**
 * The three task tools, `checklist`, `checkpoint` and `report_output`
 * (`@voluma/contracts/task-tools`). All the rules live in the task runtime; a tool only
 * names the call and turns the runtime's answer into a result: the `TaskToolResult` as
 * JSON, or a refusal's message as an error. They run one call at a time within a thread.
 */
import {
  checklistInputSchema,
  checkpointInputSchema,
  reportOutputInputSchema,
} from "@voluma/contracts/task-tools";
import { Refusal, type TaskRuntime } from "../task-runtime";
import type { Tool, ToolContext, ToolResult } from "./tool";

async function result(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { output: JSON.stringify(await run()), isError: false, truncated: false };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { output: error.message, isError: true, truncated: false };
  }
}

export function taskTools(runtime: TaskRuntime): Tool[] {
  const caller = (ctx: ToolContext) => ({
    threadId: ctx.threadId,
    toolCallId: ctx.toolCallId,
    kind: ctx.kind,
    ...(ctx.taskId && { taskId: ctx.taskId }),
  });
  const checklist: Tool<typeof checklistInputSchema> = {
    name: "checklist",
    description:
      "Set a task's status on the run's checklist, with one plain line of why. Use in-progress when you start, done when its outputs are reported, to-check when you are unsure, failed when it cannot be done.",
    input: checklistInputSchema,
    sequential: true,
    execute: (input, ctx) => result(() => runtime.checklist(caller(ctx), input)),
  };
  const checkpoint: Tool<typeof checkpointInputSchema> = {
    name: "checkpoint",
    description:
      "Record a milestone under a task, in plain language, with the files it rests on. Set toCheck when you are unsure of something a person should look at.",
    input: checkpointInputSchema,
    sequential: true,
    execute: (input, ctx) => result(() => runtime.checkpoint(caller(ctx), input)),
  };
  const reportOutput: Tool<typeof reportOutputInputSchema> = {
    name: "report_output",
    description:
      "Report one result of a task: a measurement, score, structure, annotation, volume or file. Reuse the outputId when you redo the task.",
    input: reportOutputInputSchema,
    sequential: true,
    execute: (input, ctx) => result(() => runtime.reportOutput(caller(ctx), input)),
  };
  return [checklist, checkpoint, reportOutput];
}
