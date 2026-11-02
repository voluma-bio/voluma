/**
 * The agent loop's tools, by name. A role file picks its tools from this list, under the loop
 * its run is pinned to; the task loop's list is `tools/registry.ts`, and `report_output` means
 * something else there. `buildAgentTools` builds exactly the tools a role names for one thread.
 */

import type { BashRuntime } from "../../bash-runtime";
import type { ThreadLayout } from "../../layout";
import type { Files } from "../../ports/files";
import { bashTool } from "../../tools/bash";
import { bashManageTool } from "../../tools/bash-manage";
import { segmentSamTool } from "../../tools/segment-sam";
import type { Tool } from "../../tools/tool";
import { type AgentsApi, coordinationTools } from "./coordination";
import { keepOutput } from "./keep-output";
import type { OutputToolDeps } from "./output-shared";
import { readTool } from "./read";
import { reportOutput } from "./report-output";

export const AGENT_TOOL_NAMES = [
  "bash",
  "bash_manage",
  "read",
  "segment_sam",
  "message",
  "activity",
  "close",
  "start_worker",
  "close_worker",
  "change_outputs",
  "report_output",
  "keep_output",
] as const;

const factories: Record<string, (deps: AgentToolDeps, names: readonly string[]) => Tool> = {
  bash: ({ layout, bash }) => bashTool(layout, true, bash, false),
  bash_manage: ({ bash }) => bashManageTool(bash),
  segment_sam: ({ layout }) => segmentSamTool(layout),
  read: ({ layout, files }, names) =>
    readTool({ layout, files, hasSandbox: names.includes("bash") }),
};

interface AgentToolDeps {
  layout: ThreadLayout;
  files: Files;
  bash: BashRuntime;
  api: AgentsApi;
  outputs: OutputToolDeps;
}

export function buildAgentTools(names: readonly string[], deps: AgentToolDeps): Tool[] {
  const coordination = coordinationTools(deps.api);
  const outputs: Record<string, Tool> = {
    report_output: reportOutput(deps.outputs) as unknown as Tool,
    keep_output: keepOutput(deps.outputs) as unknown as Tool,
  };
  return names.map((name) => {
    const tool = Object.hasOwn(coordination, name)
      ? coordination[name]
      : Object.hasOwn(outputs, name)
        ? outputs[name]
        : Object.hasOwn(factories, name)
          ? factories[name]?.(deps, names)
          : undefined;
    if (!tool) throw new Error(`tool "${name}" is not a tool of the agent loop`);
    return tool;
  });
}
