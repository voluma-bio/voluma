/**
 * The task tools `checkpoint`, `report_output`, `submit_task` and `ask`
 * (`@voluma/contracts/task-tools`). All the rules live in the task runtime; a tool only
 * names the call and turns the runtime's answer into a result: the `TaskToolResult` as
 * JSON, or a refusal's message as an error. They run one call at a time within a thread.
 * Which of them a role holds is its file's `tools`; the runtime refuses the rest by kind.
 */
import {
  askInputSchema,
  checkpointInputSchema,
  reportOutputInputSchema,
  submitTaskInputSchema,
} from "@voluma/contracts/task-tools";
import { Refusal, refOf, type TaskRuntime } from "../task-runtime";
import type { Tool, ToolContext, ToolResult } from "./tool";

export async function result(run: () => Promise<unknown>): Promise<ToolResult> {
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
 * A script's `objects` entry goes to `report_output` unchanged, with its files as the sandbox paths the script
 * printed. Every file the call names (the output's own, and `evidence`) given as a path becomes the ref the schema
 * takes; a path that is no file of this task is refused with the reason.
 */
export function prepareReportOutput(args: unknown, threadNames: ReadonlySet<string>): unknown {
  if (!isRecord(args) || !isRecord(args.output)) return args;
  const { taskId, output, evidence } = args;
  if (typeof taskId !== "string") return args;
  const ref = (file: unknown) =>
    typeof file === "string" ? refOf(taskId, file, threadNames) : file;
  const { structure, surface, volume } = output;
  return {
    ...args,
    ...(Array.isArray(evidence) && { evidence: evidence.map(ref) }),
    output: {
      ...output,
      ...(isRecord(structure) &&
        "mask" in structure && { structure: { ...structure, mask: ref(structure.mask) } }),
      ...(isRecord(surface) && { surface: { ...surface, heights: ref(surface.heights) } }),
      ...(isRecord(volume) && { volume: { ...volume, file: ref(volume.file) } }),
      ...("file" in output && { file: ref(output.file) }),
    },
  };
}

/**
 * What models send to `checkpoint` by habit, reshaped to the schema without losing meaning.
 * Only these habits are touched; any other unknown key stays for validation to refuse.
 * - A top-level `title` copied from `report_output` is dropped when `text` is there, and is
 *   the `text` when it is not.
 * - An evidence entry given as a sandbox path (`/outputs/<task>/x`, `/scratch/<thread>/x`) becomes its `{root, path}`.
 * - An evidence `path` that is itself `{root, path}` is unwrapped, unless its root differs
 *   from the outer one.
 * - `toCheck` given as a string, or with its words under `text`, becomes the `title` it needs;
 *   `text` beside a `title` is appended to the checkpoint's `text`.
 */
export function prepareCheckpoint(args: unknown, threadNames: ReadonlySet<string>): unknown {
  if (!isRecord(args)) return args;
  const { title, ...rest } = args;
  const out: Record<string, unknown> = { ...rest };
  if (out.text === undefined && typeof title === "string") out.text = title;
  else if (title !== undefined && typeof title !== "string") out.title = title;
  if (Array.isArray(out.evidence)) {
    const { taskId } = out;
    out.evidence = out.evidence.map((f) => {
      if (typeof f === "string" && typeof taskId === "string") return refOf(taskId, f, threadNames);
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

/** A success ends the turn; a refusal leaves the thread going. */
export const finish = (r: ToolResult): ToolResult => (r.isError ? r : { ...r, terminate: true });

/** `changed` wakes the loop: a worker's `ask` lands while the worker runs on, so no thread end does. */
export function taskTools(runtime: TaskRuntime, changed: () => void) {
  const caller = (ctx: ToolContext) => ({
    threadId: ctx.threadId,
    toolCallId: ctx.toolCallId,
    batchSize: ctx.batchSize,
    kind: ctx.kind,
    signal: ctx.signal,
    ...(ctx.taskId && { taskId: ctx.taskId }),
  });
  const checkpoint: Tool<typeof checkpointInputSchema> = {
    name: "checkpoint",
    description:
      'Record a milestone under a task, in plain language, with the files it rests on. Arguments: {taskId, text, summary, evidence: [path or {root, path}], verdict?, toCheck?: {title, focus?}}; there is no top-level title, and `text` is the milestone and `summary` one or two plain sentences for the researcher. Set toCheck when you are unsure of something a person should look at: `title` says what to look at in a few words, about the scan and not about who did or checked the work, and `text` explains. A check thread sets verdict ("passed" or "needs-review") and puts the values it re-derived in `text`: it does not report outputs.',
    input: checkpointInputSchema,
    prepare: (args) => prepareCheckpoint(args, runtime.threadNames()),
    sequential: true,
    execute: (input, ctx) => result(() => runtime.checkpoint(caller(ctx), input)),
  };
  const report_output: Tool<typeof reportOutputInputSchema> = {
    name: "report_output",
    description:
      "Report one result of a task: a measurement, score, structure, annotation, volume or file. Reuse the outputId when you redo the task.",
    input: reportOutputInputSchema,
    prepare: (args) => prepareReportOutput(args, runtime.threadNames()),
    sequential: true,
    execute: (input, ctx) => result(() => runtime.reportOutput(caller(ctx), input)),
  };
  const submit_task: Tool<typeof submitTaskInputSchema> = {
    name: "submit_task",
    description:
      "Hand your task to the check once its outputs are reported (an output you could not make is reported missing, with the reason). Call it alone: it ends your turn, and you are resumed only if the main agent sends you a message.",
    input: submitTaskInputSchema,
    sequential: true,
    execute: async (input, ctx) =>
      finish(await result(() => runtime.submitTask(caller(ctx), input))),
  };
  const ask: Tool<typeof askInputSchema> = {
    name: "ask",
    description:
      "Ask the main agent a question. A check asks what it needs answered to decide its verdict (at most 3): call it alone, it ends your turn, and the answer resumes you. A worker asks when its brief or an earlier task looks wrong, or a choice depends on what a later task needs: it does not end your turn, one question is open at a time, and the answer reaches you with a later tool result.",
    input: askInputSchema,
    sequential: true,
    execute: async (input, ctx) => {
      const sent = await result(() => runtime.ask(caller(ctx), input));
      changed();
      return ctx.kind === "check" ? finish(sent) : sent;
    },
  };
  return { checkpoint, report_output, submit_task, ask };
}
