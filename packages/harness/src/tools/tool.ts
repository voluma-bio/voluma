/**
 * What a harness tool is: a zod input schema and `execute`. Tools never import
 * Pi; the Pi adapter wraps them. The context carries what a tool may touch.
 */

import type { z } from "zod";
import type { Sandbox } from "../ports/sandbox";
import type { Role } from "../thread-log";

export interface ToolContext {
  threadId: string;
  /** The calling thread's kind and, for a worker or check thread, its task. */
  kind: "main" | Role;
  taskId?: string;
  toolCallId: string;
  /** How many tool calls the reply that made this call holds, itself included. */
  batchSize: number;
  /** Aborts when the run is cancelled; tools must stop what they started. */
  signal: AbortSignal;
  /** The calling thread's sandbox, created on first use. */
  sandbox(): Promise<Sandbox>;
  /** Live output for people watching: queued, best effort, may be dropped. */
  output(stream: "stdout" | "stderr", text: string): void;
}

/**
 * The thread's sandbox could not be created (`sandbox-session.ts`, first use or a replacement).
 * The tool lets it propagate; the Pi adapter turns it into an error result flagged `infrastructure`.
 */
export class SandboxUnavailableError extends Error {}

export interface ToolResult {
  /** What the model sees. */
  output: string;
  isError: boolean;
  /** The call failed because of Voluma's infrastructure, not the agent's input (error results only). */
  infrastructure?: true;
  /** The model saw a cut, and the full output is stored at
   * `toolOutputKey(runId, threadName, toolCallId)`, in the calling thread's own scratch folder. */
  truncated: boolean;
  /**
   * Images the model sees with the text (base64). They go to the model and the thread's
   * history, never into the `tool.result` event: the text says which files they are.
   */
  images?: { mimeType: string; data: string }[];
  /**
   * Ends the thread's turn when every result of the batch sets it (Pi's rule): the thread is
   * finished, not failed, and resumes only with a new message.
   */
  terminate?: boolean;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /**
   * Reshapes the model's raw arguments before they are validated against `input`, to accept
   * what models send by habit when the meaning is unambiguous.
   */
  prepare?(args: unknown): unknown;
  /** Runs one call at a time within its thread (the task tools, whose appends must not interleave). */
  sequential?: boolean;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}
