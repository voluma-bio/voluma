/**
 * What a harness tool is: a zod input schema and `execute`. Tools never import
 * Pi; the Pi adapter wraps them. The context carries what a tool may touch.
 */
import type { z } from "zod";
import type { Sandbox } from "../ports/sandbox";

export interface ToolContext {
  runId: string;
  threadId: string;
  toolCallId: string;
  /** Aborts when the run is cancelled; tools must stop what they started. */
  signal: AbortSignal;
  /** The run's sandbox, created on first use. */
  sandbox(): Promise<Sandbox>;
  /** Live output for people watching: best effort, may be dropped. */
  output(stream: "stdout" | "stderr", text: string): Promise<void>;
}

export interface ToolResult {
  /** What the model sees. */
  output: string;
  isError: boolean;
  /** The full output is at `toolOutputKey(runId, toolCallId)`. */
  truncated: boolean;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}
