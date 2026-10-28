/**
 * The three task tools, `checklist`, `checkpoint` and `report_output`
 * (`@voluma/contracts/task-tools`). All the rules live in the task runtime; a tool only
 * names the call and turns the runtime's answer into a result: the `TaskToolResult` as
 * JSON, or a refusal's message as an error. They run one call at a time within a thread.
 * A worker is offered all three; a check thread only `checkpoint`, since the runtime
 * refuses it the other two.
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What models send to `checkpoint` by habit, reshaped to the schema without losing meaning.
 * Only these habits are touched; any other unknown key stays for validation to refuse.
 * - A top-level `title` copied from `report_output` is dropped when `text` is there, and is
 *   the `text` when it is not.
 * - An evidence `path` that is itself `{root, path}` is unwrapped, unless its root differs
 *   from the outer one.
 * - `toCheck` given as a string, or with its words under `text`, becomes the `title` it needs;
 *   `text` beside a `title` is appended to the checkpoint's `text`.
 */
export function prepareCheckpoint(args: unknown): unknown {
  if (!isRecord(args)) return args;
  const { title, ...rest } = args;
  const out: Record<string, unknown> = { ...rest };
  if (out.text === undefined && typeof title === "string") out.text = title;
  else if (title !== undefined && typeof title !== "string") out.title = title;
  if (Array.isArray(out.evidence)) {
    out.evidence = out.evidence.map((f) => {
      if (!isRecord(f) || !isRecord(f.path)) return f;
      const root = f.path.root ?? f.root;
      return f.root !== undefined && f.path.root !== undefined && f.root !== f.path.root
        ? f
        : { ...f, ...f.path, ...(root !== undefined && { root }) };
    });
  }
  const { toCheck } = out;
  if (typeof toCheck === "string") out.toCheck = { title: toCheck };
  else if (isRecord(toCheck) && typeof toCheck.text === "string") {
    // Its words are the explanation `text` already carries: with a title they join `text`,
    // without one they are the title.
    const { text, ...kept } = toCheck;
    if (kept.title === undefined) out.toCheck = { ...kept, title: text };
    else {
      out.toCheck = kept;
      if (typeof out.text === "string" && !out.text.includes(text))
        out.text = `${out.text}\n${text}`;
    }
  }
  return out;
}

export function taskTools(runtime: TaskRuntime, kind: "worker" | "check"): Tool[] {
  const caller = (ctx: ToolContext) => ({
    threadId: ctx.threadId,
    toolCallId: ctx.toolCallId,
    kind: ctx.kind,
    ...(ctx.taskId && { taskId: ctx.taskId }),
  });
  const checklist: Tool<typeof checklistInputSchema> = {
    name: "checklist",
    description:
      "Set your task's status on the run's checklist, with one plain line of why. Use in-progress when you start, done when its outputs are reported, to-check when you are unsure, failed when it cannot be done.",
    input: checklistInputSchema,
    sequential: true,
    execute: (input, ctx) => result(() => runtime.checklist(caller(ctx), input)),
  };
  const checkpoint: Tool<typeof checkpointInputSchema> = {
    name: "checkpoint",
    description:
      'Record a milestone under a task, in plain language, with the files it rests on. Arguments: {taskId, text, evidence: [{root, path}], verdict?, toCheck?: {title, focus?}}; there is no top-level title, and `text` is the milestone. Set toCheck when you are unsure of something a person should look at: `title` says what to look at in a few words, and `text` explains. A check thread sets verdict ("passed" or "needs-review") and puts the values it re-derived in `text`: it does not report outputs.',
    input: checkpointInputSchema,
    prepare: prepareCheckpoint,
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
  return kind === "worker" ? [checklist, checkpoint, reportOutput] : [checkpoint];
}
