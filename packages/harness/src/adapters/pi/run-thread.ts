/**
 * Runs one thread on Pi's agent loop and records it twice (see the harness plan):
 * every Pi message goes to History at `message_end` (the model's view, resumable),
 * and Pi's events become EventLog events (the stream record). A thread with stored
 * history resumes from it unchanged, system message included, so the prompt cache
 * stays valid; steering and follow-ups are new messages, never edits.
 */
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type Model, Type } from "@earendil-works/pi-ai";
import type { EventInput, ThreadKind } from "@voluma/contracts/events";
import { z } from "zod";
import type { EventLog } from "../../ports/event-log";
import type { History } from "../../ports/history";
import type { Sandbox } from "../../ports/sandbox";
import type { Tool } from "../../tools/tool";

export interface RunThreadOptions {
  runId: string;
  threadId: string;
  kind: ThreadKind;
  parentThreadId?: string;
  task?: string;
  model: Model<Api>;
  /** `models.streamSimple.bind(models)` from pi-ai. */
  streamFn: StreamFn;
  /** Fixed for the thread's life; ignored when the thread already has history. */
  systemPrompt: string;
  /** The first user message; on resume, the message that continues the thread. */
  prompt: string;
  tools: Tool[];
  eventLog: EventLog;
  history: History;
  sandbox: () => Promise<Sandbox>;
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
  const { runId, threadId, eventLog, history, signal } = options;
  const emit = <T extends EventInput["type"]>(
    type: T,
    payload: Extract<EventInput, { type: T }>["payload"],
  ) =>
    eventLog.append({
      id: crypto.randomUUID(),
      runId,
      threadId,
      createdAt: new Date().toISOString(),
      type,
      payload,
    } as EventInput);

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const stored = (await history.load(threadId)).map((row) => JSON.parse(row) as AgentMessage);
  let nextIdx = stored.length;
  const persist = async (message: AgentMessage) => {
    await history.appendMessage(threadId, nextIdx, JSON.stringify(message));
    nextIdx++;
  };
  for (const result of interruptedToolResults(stored)) {
    await persist(result);
    stored.push(result);
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: options.tools.map((tool) => toAgentTool(tool, options, emit)),
      messages: stored,
    },
    streamFn: options.streamFn,
    sessionId: threadId,
  });
  // A new thread's system message is made by Pi; store it before anything else.
  if (stored.length === 0) {
    const system = agent.state.messages[0];
    if (system) {
      await persist(system);
      await emit("message", { role: "system", text: textOf(system) });
    }
  }

  agent.subscribe(async (event) => {
    switch (event.type) {
      case "message_end": {
        const { message } = event;
        await persist(message);
        if (message.role === "assistant") addUsage(usage, message);
        if (message.role === "user" || message.role === "assistant") {
          const text = textOf(message);
          if (text) await emit("message", { role: message.role, text });
        }
        break;
      }
      case "tool_execution_start":
        await emit("tool.call", {
          toolCallId: event.toolCallId,
          name: event.toolName,
          input: event.args,
        });
        break;
      case "tool_execution_end":
        await emit("tool.result", {
          toolCallId: event.toolCallId,
          isError: event.isError,
          output: textOf(event.result),
          truncated: event.result.details?.truncated === true,
        });
        break;
    }
  });
  const abort = () => agent.abort();
  signal?.addEventListener("abort", abort);

  await emit("thread.started", {
    parentThreadId: options.parentThreadId ?? null,
    kind: options.kind,
    task: options.task,
  });
  let outcome: Omit<ThreadOutcome, "usage">;
  try {
    if (signal?.aborted) outcome = { status: "cancelled" };
    else {
      await (needsUserTurn(stored) ? agent.prompt(options.prompt) : agent.continue());
      outcome = outcomeOf(agent.state.messages.at(-1), signal?.aborted === true);
    }
  } catch (error) {
    outcome = { status: "failed", error: String(error) };
    await emit("thread.ended", outcome).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  await emit("thread.ended", outcome);
  return { ...outcome, usage };
}

/** Wraps our tool as a Pi tool: JSON Schema for the model, zod for validation and defaults. */
function toAgentTool(
  tool: Tool,
  { runId, threadId, sandbox }: RunThreadOptions,
  emit: (
    type: "tool.output",
    payload: Extract<EventInput, { type: "tool.output" }>["payload"],
  ) => Promise<void>,
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
        sandbox,
        output: (stream, text) => emit("tool.output", { toolCallId, stream, text }),
      });
      return {
        content: [{ type: "text", text: result.output }],
        details: { truncated: result.truncated },
        isError: result.isError,
      };
    },
  };
}

/**
 * A crash can leave tool calls with no result, which providers reject. Answer each
 * with an error result, appended after the history, never editing it.
 */
function interruptedToolResults(messages: AgentMessage[]): AgentMessage[] {
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
  const assistant = messages[lastAssistant];
  if (assistant?.role !== "assistant" || assistant.stopReason !== "toolUse") return [];
  const answered = new Set(
    messages
      .slice(lastAssistant + 1)
      .flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
  );
  return assistant.content.flatMap((block) =>
    block.type === "toolCall" && !answered.has(block.id)
      ? [
          {
            role: "toolResult" as const,
            toolCallId: block.id,
            toolName: block.name,
            content: [{ type: "text" as const, text: "Interrupted: this command did not finish." }],
            isError: true,
            timestamp: Date.now(),
          },
        ]
      : [],
  );
}

/** A thread whose history ends in a user or tool-result message continues; otherwise it needs a new user message. */
function needsUserTurn(messages: AgentMessage[]): boolean {
  const last = messages.at(-1);
  return last === undefined || last.role === "system" || last.role === "assistant";
}

function outcomeOf(last: AgentMessage | undefined, aborted: boolean): Omit<ThreadOutcome, "usage"> {
  if (aborted) return { status: "cancelled" };
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
