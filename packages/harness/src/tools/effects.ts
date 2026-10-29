/**
 * The event id each side-effecting tool call writes, derived from the call
 * (`<thread>:<toolCallId>` plus a suffix): the call's event is stored or it is not. A repeated
 * call is a no-op because the id is already held (`recorder.ts`), and a call a crash cut off
 * is answered from the log by that id (`interruptedResult`).
 */

/** The key of a tool call in `ThreadLog.calls`: ids may repeat across threads. */
export const callKey = (threadId: string, toolCallId: string) => `${threadId}:${toolCallId}`;

const SUFFIX = {
  checkpoint: "",
  report_output: "",
  submit_task: "",
  ask: ":ask",
  start_worker: ":start_worker",
  message: ":message:open",
  stop_worker: ":stop_worker:end",
  /** The task going back to pending when a stopped worker was working on it. */
  stop_status: ":stop_worker",
  /** The attempt a worker's or main's own write opens. */
  open: ":open",
  answer: ":answer",
  accept: ":accept",
  change_plan: ":change_plan",
  finish_run: ":finish_run",
} as const;

export type EffectTool = keyof typeof SUFFIX;

export const isEffectTool = (name: string): name is EffectTool => Object.hasOwn(SUFFIX, name);

export const effectId = (tool: EffectTool, threadId: string, toolCallId: string) =>
  `${threadId}:${toolCallId}${SUFFIX[tool]}`;
