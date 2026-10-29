/**
 * The optional tools a role can be given by name, on top of the always-on bash, task and
 * thread-message tools. A tool is a factory over the run's dependencies, registered here;
 * `superviseRun` builds the ones the host grants a role (`RunRole.tools`).
 */
import type { RunLayout } from "../layout";
import type { Files } from "../ports/files";
import { segmentSamTool } from "./segment-sam";
import type { Tool } from "./tool";
import { viewImageTool } from "./view-image";

/** What a tool factory may use; a tool that needs more adds its field here. */
export interface ToolDeps {
  layout: RunLayout;
  /** The run's bucket, read and written host-side. */
  files: Files;
}

export type ToolFactory = (deps: ToolDeps) => Tool;

export const optionalTools: Readonly<Record<string, ToolFactory>> = {
  view_image: ({ layout, files }) => viewImageTool({ layout, files }),
  segment_sam: ({ layout }) => segmentSamTool(layout),
};

const isRegistered = (name: string) => Object.hasOwn(optionalTools, name);

export function buildTools(names: readonly string[], deps: ToolDeps): Tool[] {
  return names.map((name) => {
    const factory = isRegistered(name) ? optionalTools[name] : undefined;
    if (!factory) throw new Error(`tool "${name}" is not registered`);
    return factory(deps);
  });
}
