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
  "reply",
  "finish_run",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** The tools that need only the thread's own layout and the run's files. */
const factories: Record<string, (deps: ToolDeps) => Tool> = {
  bash: ({ layout }) => bashTool(layout),
  view_image: ({ layout, files }) => viewImageTool({ layout, files }),
  segment_sam: ({ layout }) => segmentSamTool(layout),
  read_file: ({ layout, files }) => readFileTool({ layout, files }),
};

export function buildTools(names: readonly string[], deps: ToolDeps): Tool[] {
  // The task and main tools are built once for the thread, not once per name.
  const coordination: Record<string, Tool> = {
    ...taskTools(deps.runtime),
    ...mainTools(deps.main),
  };
  return names.map((name) => {
    const tool = Object.hasOwn(coordination, name)
      ? coordination[name]
      : Object.hasOwn(factories, name)
        ? factories[name]?.(deps)
        : undefined;
    if (!tool) throw new Error(`tool "${name}" is not registered`);
    return tool;
  });
}
