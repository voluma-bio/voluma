/**
 * Every tool a role file may list, by name. A tool is a factory over the run's dependencies;
 * `buildTools` builds exactly the tools a role names, for the thread it is for, and fails on
 * a name it does not know. Which tools a role holds is its file's `tools` (`workflows/core/agents/`);
 * the task runtime and the main tools refuse a call by a thread of the wrong kind.
 */
import type { ThreadLayout } from "../layout";
import type { Files } from "../ports/files";
import type { TaskRuntime } from "../task-runtime";
import { bashTool } from "./bash";
import { type MainDeps, mainTools } from "./main-tools";
import { readFileTool } from "./read-file";
import { segmentSamTool } from "./segment-sam";
import { taskTools } from "./task-tools";
import type { Tool } from "./tool";
import { viewImageTool } from "./view-image";

/** What a tool factory may use; a tool that needs more adds its field here. */
export interface ToolDeps {
  layout: ThreadLayout;
  /** The run's bucket, read and written host-side. */
  files: Files;
  runtime: TaskRuntime;
  /** What the main agent's tools act through. */
  main: MainDeps;
}

export type ToolFactory = (deps: ToolDeps) => Tool;

/** Every tool name a role file may list. */
export const TOOL_NAMES = [
  "bash",
  "checkpoint",
  "report_output",
  "submit_task",
  "view_image",
  "segment_sam",
  "read_file",
  "ask",
  "start_worker",
  "message",
  "wait",
  "stop_worker",
  "answer",
  "accept",
  "change_plan",
  "finish_run",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const factories: Record<ToolName, ToolFactory> = {
  bash: ({ layout }) => bashTool(layout),
  checkpoint: ({ runtime }) => taskTools(runtime).checkpoint,
  report_output: ({ runtime }) => taskTools(runtime).report_output,
  submit_task: ({ runtime }) => taskTools(runtime).submit_task,
  ask: ({ runtime }) => taskTools(runtime).ask,
  view_image: ({ layout, files }) => viewImageTool({ layout, files }),
  segment_sam: ({ layout }) => segmentSamTool(layout),
  read_file: ({ layout, files }) => readFileTool({ layout, files }),
  start_worker: ({ main }) => mainTools(main).start_worker,
  message: ({ main }) => mainTools(main).message,
  wait: ({ main }) => mainTools(main).wait,
  stop_worker: ({ main }) => mainTools(main).stop_worker,
  answer: ({ main }) => mainTools(main).answer,
  accept: ({ main }) => mainTools(main).accept,
  change_plan: ({ main }) => mainTools(main).change_plan,
  finish_run: ({ main }) => mainTools(main).finish_run,
};

export function buildTools(names: readonly string[], deps: ToolDeps): Tool[] {
  return names.map((name) => {
    const factory = Object.hasOwn(factories, name) ? factories[name as ToolName] : undefined;
    if (!factory) throw new Error(`tool "${name}" is not registered`);
    return factory(deps);
  });
}
