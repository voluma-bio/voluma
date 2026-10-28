/**
 * The tools an agent definition grants by name (`tools:` in its frontmatter), on top of the
 * always-on bash, task and thread-message tools. This is the only way an optional tool
 * reaches a thread: a tool is a factory over the run's dependencies, registered here, and
 * `superviseRun` builds the ones a role's agent lists. A name that is not registered fails
 * the run at start (`checkToolNames`), not mid-run.
 */
import type { RunLayout } from "../layout";
import type { Files } from "../ports/files";
import type { Segmenter } from "../ports/segmenter";
import { segmentSamTool } from "./segment-sam";
import type { Tool } from "./tool";
import { viewImageTool } from "./view-image";

/** What a tool factory may use; a tool that needs more adds its field here. */
export interface ToolDeps {
  layout: RunLayout;
  /** The run's bucket, read and written host-side. */
  files: Files;
  /** Absent when the host has no key for one; `segment_sam` is then not offered. */
  segmenter?: Segmenter;
}

export type ToolFactory = (deps: ToolDeps) => Tool;

export const optionalTools: Readonly<Record<string, ToolFactory>> = {
  view_image: ({ layout, files }) => viewImageTool({ layout, files }),
  segment_sam: ({ layout, files, segmenter }) => {
    if (!segmenter)
      throw new Error("segment_sam needs a segmenter, which this host has no key for");
    return segmentSamTool({ layout, files, segmenter });
  },
};

const isRegistered = (name: string) => Object.hasOwn(optionalTools, name);

/** Throws, naming the agent and the tool, for a name the harness does not have. */
export function checkToolNames(names: readonly string[], agent: string): void {
  for (const name of names) {
    if (!isRegistered(name)) {
      const known = Object.keys(optionalTools).join(", ") || "none";
      throw new Error(
        `agent "${agent}" enables tool "${name}", which the harness does not have (available: ${known})`,
      );
    }
  }
}

export function buildTools(names: readonly string[], deps: ToolDeps): Tool[] {
  return names.map((name) => {
    const factory = isRegistered(name) ? optionalTools[name] : undefined;
    if (!factory) throw new Error(`tool "${name}" is not registered`);
    return factory(deps);
  });
}
