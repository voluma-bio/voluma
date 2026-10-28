/**
 * The tools a workflow's agent definition may enable by name (`tools:` in its frontmatter),
 * on top of the always-on bash, task and thread-message tools. A host-side tool is added
 * here; a name that is not here fails the run at start, not mid-run.
 */
import type { Tool } from "./tool";

export const optionalTools: Readonly<Record<string, Tool>> = {};

export function resolveTools(names: readonly string[], agent: string): Tool[] {
  return names.map((name) => {
    const tool = Object.hasOwn(optionalTools, name) ? optionalTools[name] : undefined;
    if (!tool) {
      const known = Object.keys(optionalTools).join(", ") || "none";
      throw new Error(
        `agent "${agent}" enables tool "${name}", which the harness does not have (available: ${known})`,
      );
    }
    return tool;
  });
}
