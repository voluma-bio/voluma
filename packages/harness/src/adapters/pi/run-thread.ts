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
   * A new user message for a thread that already has history. A thread whose last reply
   * ended its turn does nothing without one (`ran` is false in the outcome).
   */
  input?: string;
  /** Sent before `input` when a thread with history resumes mid-turn (never for a finished one). */
  resumeNote?: string;
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
  /** False when nothing happened: the thread was finished and got no input, or it was refused before starting. */
  ran: boolean;
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
  // what happened: after the first failed write nothing more is stored, nothing more is
  // emitted (the stream record follows the history), and the agent stops.
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
  const emitToolResult = (result: ToolResultMessage) =>
    emit("tool.result", {
      toolCallId: result.toolCallId,
      isError: result.isError,
      output: textOf(result),
      truncated: (result.details as { truncated?: boolean } | undefined)?.truncated === true,
    });

  let started = false;
  let outcome: Omit<ThreadOutcome, "usage" | "ran">;
  let unexpected: unknown;
  const abort = () => agent.abort();
  signal?.addEventListener("abort", abort);
  try {
    const stored = (await history.load(threadId)).map((row) => JSON.parse(row) as AgentMessage);
    nextIdx = stored.length;
    // Every check that can refuse the thread runs before `thread.started`: a refused
    // re-invocation must not relabel a finished thread in the stream record.
    if (stored.length > 0 && !sameSystem(stored[0], system)) {
      throw new ThreadFailure(
        "the stored system message differs from the current system prompt or tools; " +
          "a resumed thread keeps the prompt it started with (prompt-cache rule 1)",
      );
    }
    const repairs = interruptedToolResults(stored);
    const hasUser = stored.some((m) => m.role === "user");
    const finished = isFinished([...stored, ...repairs].at(-1));
    // A thread with no user message yet (new, or a crash before the first one was stored)
    // starts from the task. A finished one runs only for a new input; an unfinished one
    // gets the resume note first.
    const message = hasUser
      ? [finished ? undefined : options.resumeNote, options.input].filter(Boolean).join("\n\n") ||
        undefined
      : options.task;
    // With no input on a resumed thread the user message is only the restart note. When the
    // note is joined to an input, the whole message counts as the person's.
    const promptSender =
      hasUser && !options.input ? ({ kind: "system" } as const) : ({ kind: "person" } as const);
    if (message === undefined && finished) {
      return { status: "completed", ran: false, usage };
    }
    if (message === undefined && needsUserTurn([...stored, ...repairs])) {
      throw new ThreadFailure(
        `thread ${threadId} ends with an assistant message: pass an input to continue it`,
      );
    }

    started = true;
    emit("thread.started", {
      parentThreadId: options.parentThreadId ?? null,
      kind: options.kind,
      task: options.task,
    });
    if (stored.length === 0) {
      // A new thread: store the system message before anything else.
      if (system && (await persist(system))) {
        emit("message", { role: "system", text: textOf(system), sender: { kind: "system" } });
      }
    }
    // A crash can leave tool calls without results, which providers reject.
    for (const result of repairs) {
      if (!(await persist(result))) break;
      stored.push(result);
      emitToolResult(result);
    }
    if (stored.length > 0) agent.state.messages = stored;

    agent.subscribe(async (event) => {
      switch (event.type) {
        case "message_end": {
          const { message } = event;
          const ok = await persist(message);
          if (message.role === "assistant") addUsage(usage, message);
          if (!ok) break;
          if (message.role === "toolResult") emitToolResult(message);
          else if (message.role === "user" || message.role === "assistant") {
            const text = textOf(message);
            if (text) {
              const sender = message.role === "user" ? promptSender : null;
              emit("message", { role: message.role, text, sender });
            }
          }
          break;
        }
        case "tool_execution_start":
          // The call is in History (its assistant message was stored first) unless a write failed.
          if (historyError) break;
          emit("tool.call", {
            toolCallId: event.toolCallId,
            name: event.toolName,
            input: event.args,
          });
          break;
      }
    });

    if (!historyError && !signal?.aborted) {
      if (message !== undefined) await agent.prompt(message);
      else await agent.continue();
    }
    outcome = historyError
      ? historyFailure(historyError)
      : outcomeOf(agent.state.messages.at(-1), signal?.aborted === true);
  } catch (error) {
    outcome = {
      status: "failed",
      error: error instanceof ThreadFailure ? error.message : String(error),
    };
    if (!(error instanceof ThreadFailure)) unexpected = error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  // The caller owns the recorder and flushes it.
  if (started) emit("thread.ended", outcome);
  if (unexpected) throw unexpected;
  return { ...outcome, ran: started, usage };
}

/** A failure of the thread itself, as opposed to a bug: reported as the outcome, not thrown. */
class ThreadFailure extends Error {}

const historyFailure = (error: unknown): Omit<ThreadOutcome, "usage" | "ran"> => ({
  status: "failed",
  error: `storing the thread's history failed, so it stopped: ${String(error)}`,
});

/** Wraps our tool as a Pi tool: JSON Schema for the model, zod for validation and defaults. */
function toAgentTool(tool: Tool, { runId, threadId, sandbox }: RunThreadOptions): AgentTool {
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
        // Live output has no destination until the stream hub exists.
        output: () => {},
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
 * Error results for the tool calls of the last assistant message that have none: a
 * crash, or a failed write, leaves them there, and providers reject a call without a
 * result. They are appended after the history, never editing it. Pi repairs the same
 * gap when it builds a request, but only we can put the result in the stored history and
 * the stream record. Any other unanswered call cannot come from a crash or a failed write
 * (a failed write stops all writing), so the history is not trusted.
 * Errored and aborted assistant messages are skipped: Pi drops them from requests.
 */
function interruptedToolResults(messages: AgentMessage[]): ToolResultMessage[] {
  const kept = messages.filter(
    (m) => !(m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")),
  );
  const answered = new Set(kept.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])));
  const unanswered = kept.flatMap((m, i) =>
    m.role === "assistant"
      ? m.content.flatMap((block) =>
          block.type === "toolCall" && !answered.has(block.id) ? [{ block, at: i }] : [],
        )
      : [],
  );
  const lastAssistant = kept.map((m) => m.role).lastIndexOf("assistant");
  const tailIsResults = kept.slice(lastAssistant + 1).every((m) => m.role === "toolResult");
  if (
    unanswered.some(({ at }) => at !== lastAssistant) ||
    (unanswered.length > 0 && !tailIsResults)
  ) {
    throw new ThreadFailure("the stored history has a tool call without a result in its middle");
  }
  return unanswered.map(({ block }) => ({
    role: "toolResult" as const,
    toolCallId: block.id,
    toolName: block.name,
    content: [
      {
        type: "text" as const,
        text: "No result was recorded; the command may have run. Check its effects before running it again.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  }));
}

/** Pi continues a thread only from a user or tool-result message; otherwise it needs a new user message. */
function needsUserTurn(messages: AgentMessage[]): boolean {
  const last = messages.at(-1);
  return last === undefined || last.role === "system" || last.role === "assistant";
}

/** The turn ended with a reply, not mid-way through tool calls or on an error. */
const isFinished = (last: AgentMessage | undefined) =>
  last?.role === "assistant" && last.stopReason === "stop";

// A reply that ended the turn counts even if an abort came after it. Any other ending
// during an abort is a cancel: Pi records an abort that surfaces as an exception in
// the model call (after a command was killed) as an ordinary error message.
function outcomeOf(
  last: AgentMessage | undefined,
  aborted: boolean,
): Omit<ThreadOutcome, "usage" | "ran"> {
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
