/**
 * The event id each side-effecting tool call writes, derived from the call
 * (`<thread>:<toolCallId>` plus a suffix), and the result of a call a crash cut off,
 * rebuilt from the log: the call's event is stored or it is not. A repeated call is a no-op
 * because the id is already held (`recorder.ts`).
 */
import type { RunEvent } from "@voluma/contracts/events";

const SUFFIX = {
  checkpoint: "",
  report_output: "",
  submit_task: "",
  ask: ":ask",
  start_worker: ":start_worker",
  message: ":message:open",
  stop_worker: ":stop_worker:end",
  answer: ":answer",
  accept: ":accept",
  change_plan: ":change_plan",
  finish_run: ":finish_run",
} as const;

export type EffectTool = keyof typeof SUFFIX;

const isEffectTool = (name: string): name is EffectTool => Object.hasOwn(SUFFIX, name);

export const effectId = (tool: EffectTool, threadId: string, toolCallId: string) =>
  `${threadId}:${toolCallId}${SUFFIX[tool]}`;

/**
 * What a cut-off call's result says, or undefined when the log shows no effect (the thread
 * then gets the cautious default text). `message` leaves an id only when it opened an attempt;
 * a plain message is found by the user message it put in the target's thread.
 */
export function interruptedResult(
  events: readonly RunEvent[],
  threadId: string,
  tool: string,
  toolCallId: string,
): string | undefined {
  if (!isEffectTool(tool)) return undefined;
  const id = effectId(tool, threadId, toolCallId);
  const written = events.find((e) => e.id === id);
  if (written) {
    const what = tool === "start_worker" ? ` Worker ${written.threadId} was started.` : "";
    return `\`${tool}\` completed before the run was cut off.${what}`;
  }
  if (tool !== "message") return undefined;
  const call = events.find((e) => e.type === "tool.call" && e.payload.toolCallId === toolCallId);
  const input =
    call?.type === "tool.call"
      ? (call.payload.input as { threadId?: string; text?: string })
      : undefined;
  if (!input?.threadId || !input.text) return undefined;
  const sent = events.some(
    (e) =>
      e.type === "message" &&
      e.threadId === input.threadId &&
      e.payload.role === "user" &&
      e.payload.sender.kind === "thread" &&
      e.payload.sender.threadId === threadId &&
      e.payload.text.endsWith(input.text as string),
  );
  return sent ? "`message` completed before the run was cut off: the worker has it." : undefined;
}
