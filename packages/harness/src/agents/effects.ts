/**
 * The event id each side-effecting call of the agent loop writes, derived from the call
 * (`<thread>:<toolCallId>` plus a suffix), so a repeated call finds its event and a call a crash
 * cut off is answered from the log.
 */
export const reportOutputId = (threadId: string, toolCallId: string) =>
  `${threadId}:${toolCallId}:report_output`;

/** `keep_output` writes one event per output, so a call cut off between two finishes when repeated. */
export const keepOutputId = (threadId: string, toolCallId: string, outputId: string) =>
  `${threadId}:${toolCallId}:keep_output:${outputId}`;

// The coordination tools and the loop (`loop.ts`). A thread's own start is `${threadId}:started`.
export const messageEventId = (threadId: string, toolCallId: string) =>
  `${threadId}:${toolCallId}:message`;
/** A worker's own `close`: the request. */
export const closeEventId = (threadId: string, toolCallId: string) =>
  `${threadId}:${toolCallId}:close`;
export const closeWorkerId = (threadId: string, toolCallId: string) =>
  `${threadId}:${toolCallId}:close_worker`;
/** `close_worker {now}`: the worker's `cancelled` end, written before it is aborted. */
export const closeWorkerEndId = (threadId: string, toolCallId: string) =>
  `${closeWorkerId(threadId, toolCallId)}:end`;
export const activityId = (threadId: string, toolCallId: string) =>
  `${threadId}:${toolCallId}:activity`;
export const changeOutputsId = (threadId: string, toolCallId: string) =>
  `${threadId}:${toolCallId}:change_outputs`;
export const startedId = (threadId: string) => `${threadId}:started`;
/** The loop's `closed` end of a worker whose wrap-up turn ended. */
export const closedEndId = (threadId: string) => `${threadId}:closed`;
/** An unread message of an agent that closed, handed back to its sender. */
export const returnedId = (messageId: string) => `${messageId}:returned`;
/** The n-th ping of a thread, recorded before it is sent. */
export const pingId = (threadId: string, n: number) => `${threadId}:ping:${n}`;
/** The wrap-up request code makes for a worker two pings found idle. */
export const pingCloseId = (threadId: string) => `${threadId}:ping-close`;
