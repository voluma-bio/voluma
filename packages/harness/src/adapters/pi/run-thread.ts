/**
 * Runs one thread on Pi's agent loop and records it twice (see the harness plan):
 * every Pi message goes to History at `message_end` (the model's view, resumable,
 * written synchronously), and Pi's events go to the run's recorder (the stream
 * record, queued in the background). A thread with stored
 * history resumes from it unchanged, system message included, so the prompt cache
 * stays valid; steering and follow-ups are new messages, never edits.
 */
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Model,
  type ToolResultMessage,
  Type,
} from "@earendil-works/pi-ai";
import type { EventType, ThreadKind } from "@voluma/contracts/events";
import { z } from "zod";
import type { History } from "../../ports/history";
import type { Sandbox } from "../../ports/sandbox";
import type { PayloadOf, Recorder } from "../../recorder";
import type { Tool } from "../../tools/tool";

export interface RunThreadOptions {
  runId: string;
  threadId: string;
  kind: ThreadKind;
  parentThreadId?: string;
  /** The thread's first user message; also sent if a resumed thread never stored one. */
  task: string;
  /**
   * A user message to add when the thread already has history. Without one the thread
   * continues from its stored history, which must then end in a user or tool-result message.
   */
  input?: string;
  model: Model<Api>;
  /** `models.streamSimple.bind(models)` from pi-ai. */
  streamFn: StreamFn;
  /** Fixed for the thread's life: a resumed thread whose stored prompt or tools differ fails. */
  systemPrompt: string;
  tools: Tool[];
  recorder: Recorder;
  history: History;
  /** The run's sandbox for the calling thread, created on first use. */
  sandbox: (threadId: string) => Promise<Sandbox>;
  /** Aborting ends the thread as cancelled and kills a running command. */
  signal?: AbortSignal;
}

export interface ThreadOutcome {
  status: "completed" | "failed" | "cancelled";
  error?: string;
  /** Model usage of this invocation only (a resume does not recount earlier turns). */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export async function runThread(options: RunThreadOptions): Promise<ThreadOutcome> {
  const { threadId, recorder, history, signal } = options;
  const emit = <T extends EventType>(type: T, payload: PayloadOf<T>) =>
    recorder.emit(threadId, type, payload);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: options.tools.map((tool) => toAgentTool(tool, options)),
      messages: [],
    },
    streamFn: options.streamFn,
    sessionId: threadId,
  });
  // Pi made the system message the current prompt and tools call for.
  const system = agent.state.messages[0];

  // The stored history is exactly what the model saw, so it must be an exact prefix of
  // what happened: after the first failed write nothing more is stored and the agent stops.
  let nextIdx = 0;
  let historyError: unknown;
  const persist = async (message: AgentMessage): Promise<boolean> => {
    if (historyError) return false;
    try {
      await history.appendMessage(threadId, nextIdx, JSON.stringify(message));
      nextIdx++;
      return true;
    } catch (error) {
      historyError = error;
      agent.abort();
      return false;
    }
  };

  emit("thread.started", {
    parentThreadId: options.parentThreadId ?? null,
    kind: options.kind,
    task: options.task,
  });

  let outcome: Omit<ThreadOutcome, "usage">;
  const abort = () => agent.abort();
  signal?.addEventListener("abort", abort);
  try {
    const stored = (await history.load(threadId)).map((row) => JSON.parse(row) as AgentMessage);
    nextIdx = stored.length;
    if (stored.length === 0) {
      // A new thread: store the system message before anything else.
      if (system && (await persist(system))) {
        emit("message", { role: "system", text: textOf(system) });
      }
    } else if (!sameSystem(stored[0], system)) {
      throw new ThreadFailure(
        "the stored system message differs from the current system prompt or tools; " +
          "a resumed thread keeps the prompt it started with (prompt-cache rule 1)",
      );
    }
    // A crash can leave tool calls without results, which providers reject.
    for (const result of interruptedToolResults(stored)) {
      if (!(await persist(result))) break;
      stored.push(result);
      emit("tool.result", {
        toolCallId: result.toolCallId,
        isError: true,
        output: textOf(result),
        truncated: false,
      });
    }
    if (stored.length > 0) agent.state.messages = stored;

    agent.subscribe(async (event) => {
      switch (event.type) {
        case "message_end": {
          const { message } = event;
          const stored = await persist(message);
          if (message.role === "assistant") addUsage(usage, message);
          if (stored && (message.role === "user" || message.role === "assistant")) {
            const text = textOf(message);
            if (text) emit("message", { role: message.role, text });
          }
          break;
        }
        case "tool_execution_start":
          emit("tool.call", {
            toolCallId: event.toolCallId,
            name: event.toolName,
            input: event.args,
          });
          break;
        case "tool_execution_end":
          emit("tool.result", {
            toolCallId: event.toolCallId,
            isError: event.isError,
            output: textOf(event.result),
            truncated: event.result.details?.truncated === true,
          });
          break;
      }
    });

    // A thread with no user message yet (new, or a crash before the first one was stored) starts from the task.
    const message = stored.some((m) => m.role === "user") ? options.input : options.task;
    if (historyError) outcome = historyFailure(historyError);
    else if (signal?.aborted) outcome = { status: "cancelled" };
    else {
      if (message !== undefined) await agent.prompt(message);
      else if (needsUserTurn(stored)) {
        throw new Error(
          `thread ${threadId} ends with an assistant message: pass an input to continue it`,
        );
      } else await agent.continue();
      outcome = historyError
        ? historyFailure(historyError)
        : outcomeOf(agent.state.messages.at(-1), signal?.aborted === true);
    }
  } catch (error) {
    outcome = {
      status: "failed",
      error: error instanceof ThreadFailure ? error.message : String(error),
    };
    emit("thread.ended", outcome);
    await recorder.flush();
    if (error instanceof ThreadFailure) return { ...outcome, usage };
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  emit("thread.ended", outcome);
  await recorder.flush();
  return { ...outcome, usage };
}

/** A failure of the thread itself, as opposed to a bug: reported as the outcome, not thrown. */
class ThreadFailure extends Error {}

const historyFailure = (error: unknown): Omit<ThreadOutcome, "usage"> => ({
  status: "failed",
  error: `storing the thread's history failed, so it stopped: ${String(error)}`,
});

/** Wraps our tool as a Pi tool: JSON Schema for the model, zod for validation and defaults. */
function toAgentTool(
  tool: Tool,
  { runId, threadId, sandbox, recorder }: RunThreadOptions,
): AgentTool {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(tool.input, { io: "input" });
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(jsonSchema),
    execute: async (toolCallId, params, signal) => {
      const result = await tool.execute(tool.input.parse(params), {
        runId,
        threadId,
        toolCallId,
        signal: signal ?? new AbortController().signal,
        sandbox: () => sandbox(threadId),
        output: (stream, text) =>
          recorder.emit(threadId, "tool.output", { toolCallId, stream, text }),
      });
      return {
        content: [{ type: "text", text: result.output }],
        details: { truncated: result.truncated },
        isError: result.isError,
      };
    },
  };
}

/** The stored system message must be the one the current prompt and tools would make. */
function sameSystem(stored: AgentMessage | undefined, current: AgentMessage | undefined): boolean {
  const key = (m: AgentMessage | undefined) =>
    m?.role === "system" ? JSON.stringify([m.content, m.toolsAdded]) : undefined;
  return key(stored) !== undefined && key(stored) === key(current);
}

/**
 * Error results for every tool call in the history that has none: a crash, or a failed
 * write, can leave them, and providers reject a call without a result. They are appended
 * after the history, never editing it. Pi repairs the same gap when it builds a request,
 * but only we can put the result in the stored history and the event stream.
 * Calls inside an errored or aborted assistant message never ran, and Pi drops that message.
 */
function interruptedToolResults(messages: AgentMessage[]): ToolResultMessage[] {
  const answered = new Set(
    messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
  );
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    if (message.stopReason === "error" || message.stopReason === "aborted") return [];
    return message.content.flatMap((block) =>
      block.type === "toolCall" && !answered.has(block.id)
        ? [
            {
              role: "toolResult" as const,
              toolCallId: block.id,
              toolName: block.name,
              content: [
                { type: "text" as const, text: "Interrupted: this command did not finish." },
              ],
              isError: true,
              timestamp: Date.now(),
            },
          ]
        : [],
    );
  });
}

/** Pi continues a thread only from a user or tool-result message; otherwise it needs a new user message. */
function needsUserTurn(messages: AgentMessage[]): boolean {
  const last = messages.at(-1);
  return last === undefined || last.role === "system" || last.role === "assistant";
}

// A reply that ended the turn counts even if an abort came after it. Any other ending
// during an abort is a cancel: Pi records an abort that surfaces as an exception in
// the model call (after a command was killed) as an ordinary error message.
function outcomeOf(last: AgentMessage | undefined, aborted: boolean): Omit<ThreadOutcome, "usage"> {
  if (aborted && !(last?.role === "assistant" && last.stopReason === "stop")) {
    return { status: "cancelled" };
  }
  if (last?.role !== "assistant")
    return { status: "failed", error: "the thread ended without a reply" };
  switch (last.stopReason) {
    case "stop":
      return { status: "completed" };
    case "aborted":
      return { status: "cancelled" };
    case "length":
      return { status: "failed", error: "the model hit its output limit (stop reason length)" };
    case "error":
      // Claude's `refusal` is an ordinary end of the thread, not a crash.
      return {
        status: "failed",
        error:
          last.rawStopReason === "refusal"
            ? `refusal: ${last.errorMessage ?? "the model declined to continue"}`
            : (last.errorMessage ?? "the model request failed"),
      };
    default:
      return { status: "failed", error: `unexpected stop reason ${last.stopReason}` };
  }
}

function addUsage(total: ThreadOutcome["usage"], message: AssistantMessage): void {
  total.input += message.usage.input;
  total.output += message.usage.output;
  total.cacheRead += message.usage.cacheRead;
  total.cacheWrite += message.usage.cacheWrite;
  total.cost += message.usage.cost.total;
}

function textOf(message: { content: unknown }): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => (part?.type === "text" ? [part.text as string] : [])).join("");
}
