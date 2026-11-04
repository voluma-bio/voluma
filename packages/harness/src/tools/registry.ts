/**
 * The agent loop's tools, by name. A role file picks its tools from this list. `buildAgentTools` builds exactly the tools a role names for one thread.
 */

import type { BashRuntime } from "../bash-runtime";
import type { ThreadLayout } from "../layout";
import type { RunBucket } from "../ports/bucket";
import { bashTool } from "./bash";
import { bashManageTool } from "./bash-manage";
import { type AgentsApi, coordinationTools } from "./coordination";
import { gate, gatedNames } from "./gate";
import { keepOutput } from "./keep-output";
import type { OutputToolDeps } from "./output-shared";
import { readTool } from "./read";
import { reportOutput } from "./report-output";
import { segmentSamTool } from "./segment-sam";
import type { Tool } from "./tool";

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
  bash: ({ layout, bash }) => bashTool(layout, bash),
  bash_manage: ({ bash }) => bashManageTool(bash),
  segment_sam: ({ layout }) => segmentSamTool(layout),
  read: ({ layout, bucket }, names) =>
    readTool({ layout, bucket, hasSandbox: names.includes("bash") }),
};

export interface AgentToolDeps {
  layout: ThreadLayout;
  bucket: RunBucket;
  bash: BashRuntime;
  api: AgentsApi;
  outputs: OutputToolDeps;
}

function toolNamed(
  name: string,
  names: readonly string[],
  deps: AgentToolDeps,
  fileHashes?: Readonly<Record<string, string>>,
): Tool {
  const coordination = coordinationTools(deps.api);
  const outputs: Record<string, Tool> = {
    report_output: reportOutput(deps.outputs, fileHashes) as unknown as Tool,
    keep_output: keepOutput(deps.outputs) as unknown as Tool,
  };
  const tool = Object.hasOwn(coordination, name)
    ? coordination[name]
    : Object.hasOwn(outputs, name)
      ? outputs[name]
      : Object.hasOwn(factories, name)
        ? factories[name]?.(deps, names)
        : undefined;
  if (!tool) throw new Error(`tool "${name}" is not a tool of the agent loop`);
  return tool;
}

/** The tools a thread holds; those that change results are gated (`gate.ts`). */
export function buildAgentTools(names: readonly string[], deps: AgentToolDeps): Tool[] {
  const tools = names.map((name) => toolNamed(name, names, deps));
  const gated = gatedNames(tools);
  const gateDeps = { api: deps.api, hashIn: deps.outputs.hashIn };
  return tools.map((tool) => gate(tool, gated, gateDeps));
}

/** A tool as an approved call runs it: not gated, and `report_output` bound to the approved file hashes. */
export const approvedTool = (
  name: string,
  deps: AgentToolDeps,
  fileHashes: Readonly<Record<string, string>>,
): Tool => toolNamed(name, [name], deps, fileHashes);
