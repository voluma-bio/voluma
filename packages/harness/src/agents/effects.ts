/**
 * The event id each side-effecting call of the agent loop writes, derived from the call
 * (`<thread>:<toolCallId>` plus a suffix), so a repeated call finds its event and a call a crash
 * cut off is answered from the log. The task loop's table is `tools/effects.ts`; its keys are
 * tool names and some mean something else there.
 */
export const reportOutputId = (threadId: string, toolCallId: string) =>
  `${threadId}:${toolCallId}:report_output`;

/** `keep_output` writes one event per output, so a call cut off between two finishes when repeated. */
export const keepOutputId = (threadId: string, toolCallId: string, outputId: string) =>
  `${threadId}:${toolCallId}:keep_output:${outputId}`;
