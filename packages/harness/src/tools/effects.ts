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

export const fromMain = (text: string) => `From the main agent:\n${text}`;

/** What a worker is told when feedback opens a new attempt of its task. */
export const feedbackText = (taskId: string, text: string) =>
  fromMain(
    `${text}\n\nThis opens a new attempt of ${taskId}: fix it, report its outputs again, then submit_task.`,
  );

/**
 * The feedback a worker's latest attempt was opened with, when the worker has not been given
 * it: a `message` opened the attempt (its derived id) and no message from the main agent
 * reached the worker since. A cut between the two writes leaves exactly this.
 */
export function undeliveredFeedback(
  events: readonly RunEvent[],
  workerId: string,
  taskId: string,
): { text: string; from: string } | undefined {
  let at = events.length - 1;
  while (at >= 0 && !(events[at]?.type === "attempt.opened" && events[at]?.threadId === workerId))
    at--;
  const opened = events[at];
  if (!opened?.id.endsWith(SUFFIX.message)) return undefined;
  const call = events.find(
    (e) =>
      e.type === "tool.call" &&
      e.payload.name === "message" &&
      effectId("message", e.threadId, e.payload.toolCallId) === opened.id,
  );
  const input = call?.type === "tool.call" ? (call.payload.input as { text?: string }) : undefined;
  if (!call || !input?.text) return undefined;
  const given = events
    .slice(at)
    .some(
      (e) =>
        e.type === "message" &&
        e.threadId === workerId &&
        e.payload.role === "user" &&
        e.payload.sender.kind === "thread" &&
        e.payload.sender.threadId === call.threadId,
    );
  return given ? undefined : { text: feedbackText(taskId, input.text), from: call.threadId };
}

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
  if (written?.type === "attempt.opened" && tool === "message") {
    return undeliveredFeedback(events, written.threadId, written.payload.taskId)
      ? "`message` opened the new attempt before the run was cut off, and the worker is being given your text now: do not send it again."
      : "`message` completed before the run was cut off: the worker has it.";
  }
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
