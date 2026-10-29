/**
 * The optional tools a role can be given by name, on top of the always-on bash, task and
 * thread-message tools. A tool is a factory over the run's dependencies, registered here;
 * `superviseRun` builds the ones the host grants a role (`RunRole.tools`).
 */
import type { ThreadLayout } from "../layout";
import type { Files } from "../ports/files";
import type { Segmenter } from "../ports/segmenter";
import { segmentSamTool } from "./segment-sam";
import type { Tool } from "./tool";
import { viewImageTool } from "./view-image";

/** What a tool factory may use; a tool that needs more adds its field here. */
export interface ToolDeps {
  layout: ThreadLayout;
  /** The run's bucket, read and written host-side. */
  files: Files;
  /** Absent when the host has no key for one; `segment_sam` is then not offered. */
  segmenter?: Segmenter;
}

export type ToolFactory = (deps: ToolDeps) => Tool;

/**
 * Every tool name a role file may list: the base tools, the optional ones registered below, and
 * the tools of the agent loop that is replacing this one (`start_worker` ... `ask`).
 */
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

export const optionalTools: Readonly<Record<string, ToolFactory>> = {
  view_image: ({ layout, files }) => viewImageTool({ layout, files }),
  segment_sam: ({ layout, files, segmenter }) => {
    if (!segmenter)
      throw new Error("segment_sam needs a segmenter, which this host has no key for");
    return segmentSamTool({ layout, files, segmenter });
  },
};

const isRegistered = (name: string) => Object.hasOwn(optionalTools, name);

export function buildTools(names: readonly string[], deps: ToolDeps): Tool[] {
  return names.map((name) => {
    const factory = isRegistered(name) ? optionalTools[name] : undefined;
    if (!factory) throw new Error(`tool "${name}" is not registered`);
    return factory(deps);
  });
}
