/**
 * Starts one thread on Pi's agent loop and records it twice (see the harness plan):
 * every Pi message goes to History at `message_end` (the model's view, resumable,
 * written synchronously), and Pi's events go to the run's recorder (the stream
 * record, queued in the background). A thread with stored
 * history resumes from it unchanged, system message included, so the prompt cache
 * stays valid: the model keeps seeing the prompt and tool definitions the thread started
 * with, and calls run on the current tools. Notices are new text, never edits.
 *
 * `startThread` returns at once with a handle. While the thread runs, `send` puts a message
 * in the thread's inbox, and so does the thread's own runtime (compaction's notices). Nothing
 * is steered in as a user message mid-turn: the whole inbox, in arrival order, each notice
 * labelled with its sender, is appended to the last tool result of the batch that finishes
 * next, so History holds exactly what the model saw. A turn that ends with no tool call
 * while the inbox holds notices continues with them as one user message in the same format
 * (the wrap-up notice, which only matters mid-turn, is dropped there); a thread started with
 * an `input` (or messages sent before its loop begins) starts with them the same way.
 * Each notice still gets its own user `message` event with its own sender. Once the thread
 * has ended, `send` answers false, and the way to wake it is another `startThread` with the
 * same thread id and an `input`, which resumes from History (`threads.ts` does this). Several
 * threads share one process; each gets its own sandbox through `sandbox`.
 */
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  getCurrentTools,
  type Model,
  type Tool as ToolDeclaration,
  type ToolResultMessage,
  Type,
} from "@earendil-works/pi-ai";
import type { EventType } from "@voluma/contracts/events";
import { z } from "zod";
import { isContextOverflowError } from "../../context-overflow";
import { replyFrames } from "../../live";
import { usageOf } from "../../model-usage";
import type { History } from "../../ports/history";
import type { Sandbox } from "../../ports/sandbox";
import type { PayloadOf, Recorder } from "../../recorder";
import { SandboxUnavailableError, type Tool, type ToolResult } from "../../tools/tool";
import { type Compactor, compactor, foldHistory } from "./compaction";

export type UserSender = Extract<PayloadOf<"message">, { role: "user" }>["sender"];

/**
 * The `thread.started` rule on `task`, in types: a worker or check thread has a task, the main
 * agent none. The supervisor is the root and runs no agent loop, so it is not started here.
 */
type ThreadIdentity =
  | { kind: "worker" | "check"; taskId: string }
  | { kind: "main"; taskId?: undefined };

export type StartThreadOptions = ThreadIdentity & {
  threadId: string;
  /**
   * Builds the result of a tool call that a crash cut off, from the log (the caller knows what
   * the call did). `undefined` keeps the cautious default text.
   */
  interrupted?: (toolName: string, toolCallId: string) => string | undefined;
  /** The thread's first user message; also sent if a resumed thread never stored one. */
  prompt: string;
  /** The delivery cursor of a main agent's first message built from the log (`message.sender.covers`). */
  promptCovers?: string;
  /**
   * A new user message for a thread that already has history. A thread whose last reply
   * ended its turn does nothing without one (`ran` is false in the outcome).
   */
  input?: { text: string; sender: UserSender };
  model: Model<Api>;
  /** Sent as `reasoning` on each call ("off": none) and recorded on each reply. Default "off". */
  thinkingLevel?: ThinkingLevel;
  /** `models.streamSimple.bind(models)` from pi-ai. */
  streamFn: StreamFn;
  /**
   * A new thread stores both. A resumed thread keeps the stored prompt and tool definitions;
   * it is refused only if the input schema of a tool it was given changed.
   */
  systemPrompt: string;
  tools: Tool[];
  recorder: Recorder;
  history: History;
  /** The calling thread's own sandbox, created on first use. */
  sandbox: (threadId: string) => Promise<Sandbox>;
  /** Aborting ends the thread as cancelled and kills a running command. */
  signal?: AbortSignal;
  /**
   * The run's own signal. When it aborts (shutdown, self-stop, lost lease), the thread is cut
   * off, not stopped: nothing more is stored or emitted for it, not even a `thread.ended`,
   * exactly as after a crash. The next claim resumes it from what was stored.
   */
  runSignal?: AbortSignal;
};

export interface ThreadHandle {
  /** Puts a message in the running thread's inbox. False once the thread has ended. */
  send(text: string, sender: UserSender): boolean;
  done: Promise<ThreadOutcome>;
}

export interface ThreadOutcome {
  /** False when nothing happened: the thread was finished and got no input, or it was refused before starting. */
  ran: boolean;
  status: "completed" | "failed" | "cancelled";
  error?: string;
  /** The thread was refused because it cannot be resumed as stored (see `ThreadStale`). */
  stale?: true;
  /** The text of the thread's last reply in this invocation; empty if it made none. */
  reply: string;
}

export function startThread(options: StartThreadOptions): ThreadHandle {
  const { threadId, recorder, history, signal, runSignal } = options;
  const cutOff = () => runSignal?.aborted === true;
  const emit = <T extends EventType>(type: T, payload: PayloadOf<T>, id?: string) =>
    recorder.emit(threadId, type, payload, id);

  // The reply holding the call is in the agent's messages before any of its tools runs.
  const batchSize = (toolCallId: string): number => {
    for (const m of agent.state.messages.slice().reverse()) {
      if (m.role !== "assistant") continue;
      const calls = m.content.filter((b) => b.type === "toolCall");
      if (calls.some((b) => b.id === toolCallId)) return calls.length;
    }
    return 1;
  };

  // `compacting` is built before the agent but needs `persistRow`, declared below with the history cursor.
  const compacting: Compactor = compactor({
    threadId,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    streamFn: options.streamFn,
    store: (row) => persistRow(row),
    // The summary was a model call: its usage is spend (`spend.ts` counts assistant `message`s).
    onSummary: (reply, summary) => {
      const used = usageOf(reply);
      emit("message", {
        role: "assistant",
        text: summary,
        compaction: true,
        ...(used && { usage: used }),
      });
    },
  });

  const agentTools = options.tools.map((tool) => toAgentTool(tool, options, batchSize));
  const agent: Agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      tools: agentTools,
      messages: [],
    },
    streamFn: options.streamFn,
    // Delivers the inbox with the last tool result of a batch (see the file header).
    afterToolCall: async ({ assistantMessage, toolCall, result }) => {
      const calls = assistantMessage.content.filter((b) => b.type === "toolCall");
      // A terminating result ends the turn: its inbox goes in the user message that follows.
      if (inbox.length === 0 || toolCall.id !== calls.at(-1)?.id || result.terminate) return;
      const notices = inbox.splice(0);
      deliveredWith.set(toolCall.id, notices);
      return {
        content: [...result.content, { type: "text", text: `\n\n${blockOf(notices)}` }],
        details: { ...(result.details as object), inbox: true },
      };
    },
    // The one place a request's messages differ from the thread's: after a compaction.
    transformContext: async (messages, signal) => compacting.prepare(messages, signal),
    sessionId: threadId,
  });
  // Pi made the system message the current prompt and tools call for.
  const system = agent.state.messages[0];

  // The stored history is exactly what the model saw, so it must be an exact prefix of
  // what happened: after the first failed write nothing more is stored, nothing more is
  // emitted (the stream record follows the history), and the agent stops.
  let nextIdx = 0;
  let historyError: unknown;
  const persist = (message: AgentMessage) => persistRow(JSON.stringify(message));
  const persistRow = async (row: string): Promise<boolean> => {
    if (historyError || cutOff()) return false;
    try {
      await history.appendMessage(threadId, nextIdx, row);
      nextIdx++;
      return true;
    } catch (error) {
      historyError = error;
      agent.abort();
      return false;
    }
  };
  const emitToolResult = (result: ToolResultMessage) => {
    const details = result.details as
      | { truncated?: boolean; infrastructure?: true; inbox?: true }
      | undefined;
    emit("tool.result", {
      toolCallId: result.toolCallId,
      isError: result.isError,
      // The inbox block is the last part; its notices are their own events.
      output: textOf(details?.inbox ? { content: result.content.slice(0, -1) } : result),
      truncated: details?.truncated === true,
      ...(details?.infrastructure && { infrastructure: true as const }),
    });
  };

  /** Whether the log already holds an end after this thread's latest start. */
  const endedSinceStart = () => {
    const events = recorder.events();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.threadId !== threadId) continue;
      if (e.type === "thread.started") return false;
      if (e.type === "thread.ended") return true;
    }
    return false;
  };

  // The notices of each user message we prompt with (a brief has one), kept with the message
  // itself so each is recorded under its own sender.
  const noticesOf = new WeakMap<AgentMessage, Notice[]>();
  const userMessage = (notices: Notice[], text = blockOf(notices)): AgentMessage => {
    const message: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
    noticesOf.set(message, notices);
    return message;
  };
  // Everything waiting for the thread. The last check of it before the loop ends, and
  // `ended = true`, have no await between them, so a message `send` accepted is always delivered.
  const inbox: Notice[] = [];
  // The notices appended to a tool result, until its `message_end` records them.
  const deliveredWith = new Map<string, Notice[]>();
  let ended = false;
  let reply = "";

  async function run(): Promise<ThreadOutcome> {
    let started = false;
    let outcome: Omit<ThreadOutcome, "ran" | "reply">;
    let unexpected: unknown;
    const abort = () => agent.abort();
    signal?.addEventListener("abort", abort);
    try {
      const rows = await history.load(threadId);
      nextIdx = rows.length;
      const { messages: stored, compaction } = foldHistory(rows);
      compacting.restore(compaction);
      // Every check that can refuse the thread runs before the thread's own events: a refused
      // resume has its `thread.started` already (the run loop stores it first) and gets no more
      // from here; the run loop then stops it.
      if (stored.length > 0 && stored[0]?.role !== "system") {
        throw new ThreadStale("its stored history does not start with a system message");
      }
      // The model is part of a thread's identity, like its prompt: History is the record of it
      // (an assistant message names the model that wrote it), not `thread.started`, which may
      // not have landed before a crash.
      const wrote = stored.find((m) => m.role === "assistant");
      if (
        wrote?.role === "assistant" &&
        (wrote.provider !== options.model.provider || wrote.model !== options.model.id)
      ) {
        throw new ThreadStale(
          `it was written by the model ${wrote.provider}/${wrote.model} and this run uses ${options.model.provider}/${options.model.id}; a thread keeps its model`,
        );
      }
      if (stored.length > 0) {
        // The model keeps the tool definitions it started with (the system message in `stored`
        // declares them; Pi would otherwise append the difference to the current tools).
        agent.state.tools = storedTools(getCurrentTools(stored), agentTools);
      }
      const repairs = interruptedToolResults(stored, options.interrupted);
      const hasUser = stored.some((m) => m.role === "user");
      const finished = isFinished([...stored, ...repairs]);
      // A thread with no user message yet (new, or a crash before the first one was stored)
      // starts from the prompt. A finished one runs only for a new input. Each message
      // carries its sender; the prompt is the runtime's (the main agent's brief for a worker). The
      // sandbox restart note reaches the model through the sandbox's command output
      // (`sandbox-session.ts`), not as a message here.
      const prompts: AgentMessage[] = [];
      if (hasUser) {
        if (options.input?.text) inbox.unshift(options.input);
      } else if (options.prompt) {
        const brief = {
          text: options.prompt,
          sender: {
            kind: "runtime",
            ...(options.promptCovers && { covers: options.promptCovers }),
          } satisfies UserSender,
        };
        prompts.push(userMessage([brief], brief.text));
      }
      // Nothing is running, so a wrap-up notice has nothing to act on.
      const waiting = inbox.splice(0).filter((n) => !n.lapses);
      if (waiting.length > 0) prompts.push(userMessage(waiting));
      const message = prompts.length > 0 ? prompts : undefined;
      if (message === undefined && finished) {
        return { status: "completed", ran: false, reply };
      }
      if (message === undefined && needsUserTurn([...stored, ...repairs])) {
        throw new ThreadFailure(
          `thread ${threadId} ends with an assistant message: pass an input to continue it`,
        );
      }

      started = true;
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

      // The id the reply's live frames carry, picked when it starts and used by its `message`.
      let replyId: string | undefined;
      let frames: ReturnType<typeof replyFrames> | undefined;
      agent.subscribe(async (event) => {
        switch (event.type) {
          case "message_start":
            if (event.message.role === "assistant") {
              replyId = crypto.randomUUID();
              frames = replyFrames(threadId, replyId, recorder.live);
            }
            break;
          case "message_update":
            frames?.(event.assistantMessageEvent);
            break;
          case "message_end": {
            const { message } = event;
            const ok = await persist(message);
            if (message.role === "assistant") {
              reply = textOf(message);
            }
            if (!ok) break;
            if (message.role === "toolResult") {
              emitToolResult(message);
              for (const { text, sender } of deliveredWith.get(message.toolCallId) ?? []) {
                emit("message", { role: "user", text, sender });
              }
              deliveredWith.delete(message.toolCallId);
            } else if (message.role === "assistant") {
              // Every reply gets a `message`, even an empty or failed one: it ends the
              // reply's live partial (`stream.ts`).
              const used = usageOf(message);
              const reasoning = reasoningOf(message);
              recorder.emit(
                threadId,
                "message",
                {
                  role: "assistant",
                  text: textOf(message),
                  ...(reasoning && { reasoning }),
                  ...(used && { usage: used }),
                },
                replyId,
              );
              replyId = frames = undefined;
            } else if (message.role === "user") {
              const notices = noticesOf.get(message);
              if (!notices) throw new Error("a user message reached message_end without a sender");
              for (const { text, sender } of notices) {
                if (text) emit("message", { role: "user", text, sender });
              }
            }
            break;
          }
          case "turn_end": {
            // Tools ran, so another turn follows: the thread can still use the notice.
            if (historyError || cutOff() || event.toolResults.length === 0) break;
            const notice = compacting.wrapUp(agent.state.messages);
            if (notice) inbox.push({ text: notice, sender: NOTICE, lapses: true });
            break;
          }
          case "tool_execution_start":
            // The call is in History (its assistant message was stored first) unless a write failed.
            if (historyError || cutOff()) break;
            emit("tool.call", {
              toolCallId: event.toolCallId,
              name: event.toolName,
              input: event.args,
            });
            break;
        }
      });

      let prompted = false;
      if (!historyError && !signal?.aborted) {
        prompted = true;
        if (message !== undefined) await agent.prompt(message);
        else await agent.continue();
        // A message that arrived as the loop was ending is still in the inbox. A request the provider
        // refused as too large is retried once, after a compaction; the note that starts the retry
        // is stored only once the summary was.
        while (!historyError && !signal?.aborted) {
          if (overflowRetryable(agent.state.messages)) {
            const recovered = await compacting.recover(agent.state.messages, signal).catch((e) => {
              // The summary's own provider failure ends the thread as that failure, which the run retries.
              throw new ThreadFailure(e instanceof Error ? e.message : String(e));
            });
            if (!recovered) break;
            inbox.push({ text: OVERFLOW_NOTE, sender: NOTICE });
          }
          inbox.splice(0, inbox.length, ...inbox.filter((n) => !n.lapses));
          if (inbox.length === 0) break;
          await agent.prompt(userMessage(inbox.splice(0)));
        }
      }
      // Stopped before its first prompt, it did nothing this invocation: its turn from before
      // must not read as this invocation completing.
      outcome = historyError
        ? historyFailure(historyError)
        : signal?.aborted && !prompted
          ? { status: "cancelled" }
          : outcomeOf(agent.state.messages, signal?.aborted === true);
    } catch (error) {
      outcome = {
        status: "failed",
        error: error instanceof ThreadFailure ? error.message : String(error),
        ...(error instanceof ThreadStale && { stale: true }),
      };
      if (!(error instanceof ThreadFailure)) unexpected = error;
    } finally {
      ended = true;
      signal?.removeEventListener("abort", abort);
    }
    // The caller owns the recorder and flushes it. A stop stored its own end first (append-first):
    // the thread's end is then a second one for the same start, and is dropped.
    if (started && !cutOff()) {
      await recorder.flush();
      if (!endedSinceStart()) emit("thread.ended", outcome);
    }
    if (unexpected) throw unexpected;
    return { ...outcome, ran: started, reply };
  }

  return {
    send(text, sender) {
      if (ended) return false;
      inbox.push({ text, sender });
      return true;
    },
    done: run(),
  };
}

/** One entry of a thread's inbox. A `lapses` notice only matters while the thread is running a turn. */
interface Notice {
  text: string;
  sender: UserSender;
  lapses?: true;
}

const senderLabel = (s: UserSender) =>
  s.kind === "thread" ? "the main agent" : s.kind === "person" ? "the researcher" : "Voluma";

/** The text the model reads for a set of notices, in arrival order. */
const blockOf = (notices: Notice[]) =>
  `New messages for you:\n\n${notices.map((n) => `From ${senderLabel(n.sender)}:\n${n.text}`).join("\n\n")}`;

/** The sender of compaction notices: the runtime, but not a nudge. */
const NOTICE: UserSender = { kind: "runtime", notice: true };

const OVERFLOW_NOTE =
  "The last request was too large for the model, so your history was summarized. Continue the task.";

/** Whether the thread ended on a too-large request whose predecessor, if it was one, was not also refused. */
function overflowRetryable(messages: AgentMessage[]): boolean {
  const replies = messages.filter((m) => m.role === "assistant");
  const [last, before] = [replies.at(-1), replies.at(-2)];
  const refused = (m: AgentMessage | undefined) =>
    m?.role === "assistant" && m.stopReason === "error" && isContextOverflowError(m.errorMessage);
  return messages.at(-1) === last && refused(last) && !refused(before);
}

/** A failure of the thread itself, as opposed to a bug: reported as the outcome, not thrown. */
class ThreadFailure extends Error {}

/**
 * The stored thread cannot be resumed as it is (a deploy changed the input of one of its tools,
 * or its model changed): `ran` is false and `stale` true. The caller starts the work again on a new thread.
 */
class ThreadStale extends ThreadFailure {}

const historyFailure = (error: unknown): Omit<ThreadOutcome, "ran" | "reply"> => ({
  status: "failed",
  error: `storing the thread's history failed, so it stopped: ${String(error)}`,
});

/** Wraps our tool as a Pi tool: JSON Schema for the model, zod for validation and defaults. */
function toAgentTool(
  tool: Tool,
  { threadId, kind, taskId, sandbox, recorder }: StartThreadOptions,
  batchSize: (toolCallId: string) => number,
): AgentTool {
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(tool.input, { io: "input" });
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(strictObjects(jsonSchema)),
    ...(tool.prepare && { prepareArguments: tool.prepare }),
    ...(tool.sequential && { executionMode: "sequential" as const }),
    execute: async (toolCallId, params, signal) => {
      let result: ToolResult;
      try {
        result = await tool.execute(tool.input.parse(params), {
          threadId,
          kind,
          ...(taskId && { taskId }),
          toolCallId,
          batchSize: batchSize(toolCallId),
          signal: signal ?? new AbortController().signal,
          sandbox: () => sandbox(threadId),
          output: (stream, text) =>
            recorder.live({ type: "tool.output", threadId, toolCallId, stream, text }),
        });
      } catch (error) {
        // Voluma's failure, not the call's: recorded as `infrastructure`, and the run page
        // doesn't count it as the agent's failed call.
        if (!(error instanceof SandboxUnavailableError)) throw error;
        result = { output: error.message, isError: true, infrastructure: true, truncated: false };
      }
      return {
        content: [
          { type: "text" as const, text: result.output },
          ...(result.images ?? []).map((i) => ({ type: "image" as const, ...i })),
        ],
        // `details` is stored with the message: a terminating batch is told from it on resume (`isFinished`).
        details: {
          truncated: result.truncated,
          terminate: result.terminate === true,
          ...(result.infrastructure && { infrastructure: true }),
        },
        isError: result.isError,
        ...(result.terminate && { terminate: true }),
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

/**
 * A schema without its `description` keywords, for comparing what a call may contain. Keys
 * of a map of named schemas (`properties`, `$defs`) are names, so only their values are walked.
 */
function withoutDescriptions(schema: unknown, named = false): unknown {
  if (Array.isArray(schema)) return schema.map((s) => withoutDescriptions(s));
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => named || key !== "description")
      .map(([key, value]) => [
        key,
        withoutDescriptions(value, !named && ["properties", "$defs", "definitions"].includes(key)),
      ]),
  );
}

/**
 * The tools a resumed thread offers: the definitions it started with, run by the current tool
 * of the same name. A tool whose input schema changed since is refused as stale: Pi checks a
 * call against the stored schema and `execute` then parses it with the current one, so a call
 * could pass one and fail the other for the rest of the thread. A description change resumes,
 * the tool's or a field's (`.describe()`); a changed default or any other keyword is refused.
 * A tool since removed answers a call with an error; a tool added since is not offered.
 * (A changed `prepare` cannot be seen: the stored definitions do not carry it.)
 */
function storedTools(declared: ToolDeclaration[], current: AgentTool[]): AgentTool[] {
  return declared.map((d) => {
    const now = current.find((t) => t.name === d.name);
    if (
      now &&
      JSON.stringify(withoutDescriptions(now.parameters)) !==
        JSON.stringify(withoutDescriptions(d.parameters))
    ) {
      throw new ThreadStale(`the input of its tool ${d.name} changed since it started`);
    }
    return {
      label: d.name,
      execute: async () => ({
        content: [{ type: "text" as const, text: `The tool ${d.name} is no longer available.` }],
        details: {},
        isError: true,
      }),
      ...now,
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    };
  });
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
function interruptedToolResults(
  messages: AgentMessage[],
  interrupted: StartThreadOptions["interrupted"],
): ToolResultMessage[] {
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
  return unanswered.map(({ block }) => {
    const built = interrupted?.(block.name, block.id);
    return {
      role: "toolResult" as const,
      toolCallId: block.id,
      toolName: block.name,
      content: [
        {
          type: "text" as const,
          text:
            built ??
            "No result was recorded; the command may have run. Check its effects before running it again.",
        },
      ],
      isError: built === undefined,
      timestamp: Date.now(),
    };
  });
}

/** Pi continues a thread only from a user or tool-result message; otherwise it needs a new user message. */
function needsUserTurn(messages: AgentMessage[]): boolean {
  const last = messages.at(-1);
  return last === undefined || last.role === "system" || last.role === "assistant";
}

/**
 * The turn ended: with a reply, or with a batch whose every result set `terminate` (stored in
 * the result's `details`) and that answers every call of the reply before it. Not mid-way
 * through tool calls, and not on an error.
 */
function isFinished(messages: AgentMessage[]): boolean {
  const last = messages.at(-1);
  if (last?.role === "assistant") return last.stopReason === "stop";
  if (last?.role !== "toolResult") return false;
  const at = messages.map((m) => m.role).lastIndexOf("assistant");
  const reply = messages[at];
  if (reply?.role !== "assistant") return false;
  const results = messages.slice(at + 1);
  const calls = reply.content.filter((b) => b.type === "toolCall").length;
  return (
    results.length === calls &&
    results.every(
      (m) =>
        m.role === "toolResult" && (m.details as { terminate?: boolean } | undefined)?.terminate,
    )
  );
}

// A reply that ended the turn counts even if an abort came after it. Any other ending
// during an abort is a cancel: Pi records an abort that surfaces as an exception in
// the model call (after a command was killed) as an ordinary error message.
function outcomeOf(
  messages: AgentMessage[],
  aborted: boolean,
): Omit<ThreadOutcome, "ran" | "reply"> {
  const last = messages.at(-1);
  if (isFinished(messages)) return { status: "completed" };
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

function textOf(message: { content: unknown }): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => (part?.type === "text" ? [part.text as string] : [])).join("");
}

/** The reply's thinking blocks, joined with a blank line (`message.reasoning`). */
function reasoningOf(message: { content: unknown }): string {
  const { content } = message;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part?.type === "thinking" && part.thinking ? [part.thinking as string] : [],
    )
    .join("\n\n");
}
