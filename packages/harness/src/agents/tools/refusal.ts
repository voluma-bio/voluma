import type { ToolResult } from "../../tools/tool";

/** A call the rules turn down; its message is the tool error the agent reads. */
export class Refusal extends Error {}

/** Runs a call and turns a refusal into the tool's error result; the answer is JSON. */
export async function result(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { output: JSON.stringify(await run()), isError: false, truncated: false };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { output: error.message, isError: true, truncated: false };
  }
}
