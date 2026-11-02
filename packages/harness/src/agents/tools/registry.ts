/**
 * The agent loop's tools, by name. A role file of `workflows/core/roles/` lists only these (the
 * loader checks its `tools` against `AGENT_TOOL_NAMES`). The task loop has its own registry
 * (`tools/registry.ts`), and a name in both (`read`, `report_output`) is a different tool in each:
 * a role file picks by the loop it runs under.
 */
import type { ThreadLayout } from "../../layout";
import type { Files } from "../../ports/files";
import { bashTool } from "../../tools/bash";
import { segmentSamTool } from "../../tools/segment-sam";
import type { Tool } from "../../tools/tool";
import { readTool } from "./read";

export interface AgentToolDeps {
  layout: ThreadLayout;
  /** The run's bucket, read host-side. */
  files: Files;
}

/** Every tool name a role file of the agent loop may list. */
export const AGENT_TOOL_NAMES = [
  "message",
  "close",
  "start_worker",
  "close_worker",
  "change_outputs",
  "keep_output",
  "report_output",
  "bash",
  "bash_manage",
  "read",
  "segment_sam",
] as const;

const factories: Record<string, (deps: AgentToolDeps, names: readonly string[]) => Tool> = {
  bash: ({ layout }) => bashTool(layout, true),
  segment_sam: ({ layout }) => segmentSamTool(layout),
  read: ({ layout, files }, names) =>
    readTool({ layout, files, hasSandbox: names.includes("bash") }),
};

export function buildAgentTools(names: readonly string[], deps: AgentToolDeps): Tool[] {
  return names.map((name) => {
    const tool = Object.hasOwn(factories, name) ? factories[name]?.(deps, names) : undefined;
    if (!tool) throw new Error(`tool "${name}" is not registered`);
    return tool;
  });
}
