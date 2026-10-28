/**
 * The tools an agent definition grants by name (`tools:` in its frontmatter), on top of the
 * always-on bash, task and thread-message tools. This is the only way an optional tool
 * reaches a thread: a tool is a factory over the run's dependencies, registered here, and
 * `superviseRun` builds the ones a role's agent lists. A name that is not registered fails
 * the run at start (`checkToolNames`), not mid-run.
 */
import type { RunLayout } from "../layout";
import type { Tool } from "./tool";

/** What a tool factory may use; a tool that needs more (files, a segmenter) adds its field here. */
export interface ToolDeps {
  layout: RunLayout;
}

export type ToolFactory = (deps: ToolDeps) => Tool;

export const optionalTools: Readonly<Record<string, ToolFactory>> = {};

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
