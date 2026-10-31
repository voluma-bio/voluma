/**
 * Read-time repair of a thread's tool calls and results. The stored rows are never rewritten:
 * the request is a pure function of them (the same rows give the same bytes, so a resume keeps
 * the provider's prompt cache), and each repair is logged once per thread's run. A request
 * view is what the repair acts on, so row indices and compaction indices stay as stored.
 *
 * Rules, each by name in the log:
 * - `unanswered-call`: a tool call whose result is not among the results that follow its
 *   message gets the fixed "interrupted" result (the one a crash at the tail gets, stored).
 * - `orphan-result`: a tool result with no call in the message before it is left out.
 * Row-level rules (`unreadable-message`, `unreadable-marker`) are `foldHistory`'s;
 * `image-unreadable` is `image-refs.ts`'s.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

export type Interrupted = (toolName: string, toolCallId: string) => string | undefined;

/** The error result for a call that has none: the tool's own text if it has one. */
export function interruptedResult(
  call: { id: string; name: string },
  interrupted: Interrupted | undefined,
  timestamp = Date.now(),
): ToolResultMessage {
  const built = interrupted?.(call.name, call.id);
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [
      {
        type: "text",
        text:
          built ??
          "No result was recorded; the command may have run. Check its effects before running it again.",
      },
    ],
    isError: built === undefined,
    timestamp,
  };
}

/** Logs a repair the first time it happens for a thread, however many requests carry it. */
export function repairLog(threadId: string) {
  const seen = new Set<string>();
  return (rule: string, detail: string) => {
    if (seen.has(`${rule} ${detail}`)) return;
    seen.add(`${rule} ${detail}`);
    console.warn(`history-repair: thread ${threadId}: ${rule} ${detail}`);
  };
}

/**
 * The messages with every call answered and every result matched, as the provider requires.
 * Errored and aborted assistant messages are Pi's to drop and are left as they are. Returns
 * the input itself when nothing needed repair.
 */
export function repairToolPairs(
  messages: AgentMessage[],
  interrupted: Interrupted | undefined,
  log: (rule: string, detail: string) => void,
): AgentMessage[] {
  const out: AgentMessage[] = [];
  let pending = new Map<string, { id: string; name: string }>();
  let repaired = false;
  const close = () => {
    for (const call of pending.values()) {
      log("unanswered-call", `call ${call.id} (${call.name})`);
      // Timestamp 0: a fixed message, so the request is the same every time.
      out.push(interruptedResult(call, interrupted, 0));
      repaired = true;
    }
    pending = new Map();
  };
  for (const m of messages) {
    if (m.role === "toolResult") {
      if (pending.delete(m.toolCallId)) out.push(m);
      else {
        log("orphan-result", `result of call ${m.toolCallId}`);
        repaired = true;
      }
      continue;
    }
    if (m.role === "system") {
      out.push(m); // transparent to tool-call pairing, as in Pi
      continue;
    }
    close();
    out.push(m);
    if (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") {
      for (const b of m.content) if (b.type === "toolCall") pending.set(b.id, b);
    }
  }
  close();
  return repaired ? out : messages;
}
