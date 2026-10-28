/**
 * Starts one thread on Pi's agent loop and records it twice (see the harness plan):
 * every Pi message goes to History at `message_end` (the model's view, resumable,
 * written synchronously), and Pi's events go to the run's recorder (the stream
 * record, queued in the background). A thread with stored
 * history resumes from it unchanged, system message included, so the prompt cache
 * stays valid; steering and follow-ups are new messages, never edits.
 *
 * `startThread` returns at once with a handle. While the thread runs, `send` steers a
 * message into it (Pi's steering queue: delivered after the current tool calls); one sent
 * before the loop starts is queued for it. Once the thread has ended, `send` answers false, and the way to wake it is another `startThread` with the same
 * thread id and an `input`, which resumes from History (`threads.ts` does this). Several
 * threads share one process, and one sandbox through `sandbox`.
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
import type { EventType } from "@voluma/contracts/events";
import { z } from "zod";
import type { History } from "../../ports/history";
import type { Sandbox } from "../../ports/sandbox";
import type { PayloadOf, Recorder } from "../../recorder";
import type { Tool } from "../../tools/tool";
import { elideOldImages } from "./elide-images";

export type UserSender = Extract<PayloadOf<"message">, { role: "user" }>["sender"];

/**
 * The `thread.started` rule on `task`, in types: a worker or check thread has a task. The
 * supervisor is the root and runs no agent loop, so it is not started here.
 */
type ThreadIdentity =
  | { kind: "worker" | "check"; taskId: string }
  | { kind: "chat"; taskId?: string };

export type StartThreadOptions = ThreadIdentity & {
  runId: string;
  threadId: string;
  parentThreadId?: string;
  /** The attempt a check thread checks. */
  attemptId?: string;
  /** The tool call in the parent thread that started this thread. */
  spawnedBy?: string;
  /** Workflow packages the run is pinned to; set on the root thread only. */
  workflows?: PayloadOf<"thread.started">["workflows"];
  /** The thread's first user message; also sent if a resumed thread never stored one. */
  prompt: string;
  /**
   * A new user message for a thread that already has history. A thread whose last reply
   * ended its turn does nothing without one (`ran` is false in the outcome).
   */
  input?: { text: string; sender: UserSender };
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
};

export interface ThreadHandle {
  /** Steers a user message into the running thread. False once the thread has ended or never ran. */
  send(text: string, sender?: UserSender): boolean;
  done: Promise<ThreadOutcome>;
}

export interface ThreadOutcome {
  /** False when nothing happened: the thread was finished and got no input, or it was refused before starting. */
  ran: boolean;
  status: "completed" | "failed" | "cancelled";
  error?: string;
  /** The text of the thread's last reply in this invocation; empty if it made none. */
  reply: string;
  /** Model usage of this invocation only (a resume does not recount earlier turns). */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export function startThread(options: StartThreadOptions): ThreadHandle {
  const { threadId, recorder, history, signal } = options;
  const emit = <T extends EventType>(type: T, payload: PayloadOf<T>) =>
    recorder.emit(threadId, type, payload);
  const usage = { input: 0, output: 0, cacheRead: 0, cost: 0, cacheWrite: 0 };

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: options.tools.map((tool) => toAgentTool(tool, options)),
      messages: [],
    },
    streamFn: options.streamFn,
    transformContext: async (messages) => elideOldImages(messages),
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

  // The sender of each user message we prompt with, kept with the message itself.
  const senders = new WeakMap<AgentMessage, UserSender>();
  const userMessage = (text: string, sender: UserSender): AgentMessage => {
    const message: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
    senders.set(message, sender);
    return message;
  };
  // True from the moment the agent loop is about to start until its last check for queued
  // messages, with no await between that check and clearing it, so a message accepted here
  // is always run.
  let accepting = false;
  let ended = false;
  // Messages sent before the loop starts; they join the first turn (or are steered in).
  const early: { text: string; sender: UserSender }[] = [];
  let reply = "";

  async function run(): Promise<ThreadOutcome> {
    let started = false;
    let outcome: Omit<ThreadOutcome, "usage" | "ran" | "reply">;
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
      // starts from the prompt. A finished one runs only for a new input. Each message
      // carries its sender; the prompt counts as a person's, since the harness can't tell a
      // supervisor's task from a human's. The sandbox restart note reaches the model through
      // the sandbox's command output (`sandbox-session.ts`), not as a message here.
      const prompts: AgentMessage[] = [];
      const addPrompt = (text: string | undefined, sender: UserSender) => {
        if (text) prompts.push(userMessage(text, sender));
      };
      if (hasUser) {
        if (options.input) addPrompt(options.input.text, options.input.sender);
      } else {
        addPrompt(options.prompt, { kind: "person" });
      }
      for (const { text, sender } of early.splice(0)) addPrompt(text, sender);
      const message = prompts.length > 0 ? prompts : undefined;
      if (message === undefined && finished) {
        return { status: "completed", ran: false, reply, usage };
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
        ...(options.taskId && { task: options.taskId }),
        ...(options.attemptId && { attemptId: options.attemptId }),
        ...(options.spawnedBy && { spawnedBy: options.spawnedBy }),
        ...(options.workflows && { workflows: options.workflows }),
      });
      if (stored.length === 0) {
        // A new thread: store the system message before anything else.
        if (system && (await persist(system))) {
          emit("message", { role: "system", text: textOf(system) });
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
            if (message.role === "assistant") {
              addUsage(usage, message);
              reply = textOf(message);
            }
            if (!ok) break;
            if (message.role === "toolResult") emitToolResult(message);
            else if (message.role === "assistant") {
              // Every reply gets a `message`, even an empty or failed one: it ends the
              // reply's live partial (`stream.ts`).
              emit("message", { role: "assistant", text: textOf(message) });
            } else if (message.role === "user") {
              const sender = senders.get(message);
              if (!sender) throw new Error("a user message reached message_end without a sender");
              const text = textOf(message);
              if (text) emit("message", { role: "user", text, sender });
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
        accepting = true;
        for (const { text, sender } of early.splice(0)) agent.steer(userMessage(text, sender));
        if (message !== undefined) await agent.prompt(message);
        else await agent.continue();
        // A message steered in as the loop was ending is still queued.
        while (!historyError && !signal?.aborted && agent.hasQueuedMessages()) {
          await agent.continue();
        }
      }
      accepting = false;
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
      accepting = false;
      ended = true;
      signal?.removeEventListener("abort", abort);
    }
    // The caller owns the recorder and flushes it.
    if (started) emit("thread.ended", outcome);
    if (unexpected) throw unexpected;
    return { ...outcome, ran: started, reply, usage };
  }

  return {
    send(text, sender = { kind: "person" }) {
      if (ended) return false;
      if (!accepting) {
        early.push({ text, sender });
        return true;
      }
      agent.steer(userMessage(text, sender));
      return true;
    },
    done: run(),
  };
}

/** A failure of the thread itself, as opposed to a bug: reported as the outcome, not thrown. */
class ThreadFailure extends Error {}

const historyFailure = (error: unknown): Omit<ThreadOutcome, "usage" | "ran" | "reply"> => ({
  status: "failed",
  error: `storing the thread's history failed, so it stopped: ${String(error)}`,
});

/** Wraps our tool as a Pi tool: JSON Schema for the model, zod for validation and defaults. */
function toAgentTool(
  tool: Tool,
  { runId, threadId, kind, taskId, sandbox }: StartThreadOptions,
): AgentTool {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(tool.input, { io: "input" });
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(strictObjects(jsonSchema)),
    ...(tool.sequential && { executionMode: "sequential" as const }),
    execute: async (toolCallId, params, signal) => {
      const result = await tool.execute(tool.input.parse(params), {
        runId,
        threadId,
        kind,
        ...(taskId && { taskId }),
        toolCallId,
        signal: signal ?? new AbortController().signal,
        sandbox: () => sandbox(threadId),
        // Live output has no destination until the stream hub exists.
        output: () => {},
      });
      return {
        content: [
          { type: "text" as const, text: result.output },
          ...(result.images ?? []).map((i) => ({ type: "image" as const, ...i })),
        ],
        details: { truncated: result.truncated },
        isError: result.isError,
      };
    },
  };
}

/**
 * Closes every object schema (`additionalProperties: false`), so a field a tool does not
 * take is refused when Pi validates the call, instead of silently dropped by zod.
 */
function strictObjects<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(strictObjects) as T;
  if (typeof schema !== "object" || schema === null) return schema;
  const entries = Object.entries(schema).map(([key, value]) => [key, strictObjects(value)]);
  const closed = Object.fromEntries(entries);
  return (
    closed.type === "object" && closed.properties && closed.additionalProperties === undefined
      ? { ...closed, additionalProperties: false }
      : closed
  ) as T;
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
): Omit<ThreadOutcome, "usage" | "ran" | "reply"> {
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
