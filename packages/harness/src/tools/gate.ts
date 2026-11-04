/**
 * The review gate. While the run is reviewing (`AgentLog.reviewing`), main's call to a tool that
 * changes results (`Tool.changesResults`) is not run: code writes `approval.requested` and answers
 * the call "held", and the turn ends. Pi ends a turn only when every result of the batch
 * terminates, so the gate wraps all of main's tools: a batch that holds a changes-results call
 * ends the turn, the other calls running as usual and terminating beside it. A held call lives in
 * the log and needs no claim; the researcher's yes starts the stored call as a job (`loop.ts`,
 * `startApproved`). The gate is on the tool, not in a role file, and only main is gated: a worker
 * also has `report_output`, and its limit is `outputs`.
 */

import { isDeepStrictEqual } from "node:util";
import { approvalRequestId, openApprovals } from "@voluma/contracts/agents";
import { madeStale } from "../approvals";
import type { AgentsApi } from "./coordination";
import { Refusal } from "./refusal";
import type { Tool, ToolContext } from "./tool";

export const heldText = (toolCallId: string) =>
  `Held for the researcher (approval ${toolCallId}). Your turn ends; the answer arrives as a delivery.`;

export const alreadyWaitingText = (tool: string) =>
  `Refused: this ${tool} call is already waiting on the researcher, with the same arguments. Do not send it again; end your turn and wait for the answer, which arrives as a delivery.`;

export interface GateDeps {
  api: AgentsApi;
  /** The sha256 of a file where the thread's sandbox has it mounted. */
  hashIn(threadId: string, path: string, signal: AbortSignal): Promise<string>;
}

/** The names of the tools that carry the flag among `tools`. */
export const gatedNames = (tools: readonly Tool[]) =>
  new Set(tools.filter((t) => t.changesResults).map((t) => t.name));

/** Wraps one of main's tools; `gated` is `gatedNames` of all of them. */
export function gate(tool: Tool, gated: ReadonlySet<string>, deps: GateDeps): Tool {
  const { api } = deps;
  const holds = (ctx: ToolContext) => ctx.agent.role === "main" && api.log().reviewing;
  const flag = tool.changesResults;
  if (!flag) {
    return {
      ...tool,
      async execute(input, ctx) {
        if (!holds(ctx) || !ctx.batch.some((n) => gated.has(n))) return tool.execute(input, ctx);
        // `close` would end the run, and with it the review, before the held call is answered.
        if (tool.name === "close")
          return {
            output:
              "Call close on its own: another call in this batch may be held for the researcher's answer, and close would end the run before it.",
            isError: true,
            truncated: false,
          };
        const result = await tool.execute(input, ctx);
        return { ...result, terminate: true };
      },
    };
  }
  return {
    ...tool,
    async execute(input, ctx) {
      if (!holds(ctx)) return tool.execute(input, ctx);
      const requestId = approvalRequestId(ctx.threadId, ctx.toolCallId);
      try {
        // A preflight takes the run's section itself when it reads the log to decide.
        if (!api.log().written.has(requestId)) {
          await flag.preflight(input, ctx);
          const fileHashes: Record<string, string> = {};
          for (const f of flag.files?.(input, ctx) ?? [])
            fileHashes[f.key] = await deps.hashIn(ctx.threadId, f.path, ctx.signal);
          const outputs = flag.outputs(input);
          // Main re-issues a call after a nudge or a repeated delivery; one change gets one card.
          // Checked inside the section so two identical calls in one batch cannot both hold, and
          // with the file hashes so a re-report of an edited file is a new request.
          const duplicate = await api.section(async () => {
            if (
              openApprovals(api.log().approvals).some(
                (a) =>
                  a.tool === tool.name &&
                  isDeepStrictEqual(a.args, input) &&
                  isDeepStrictEqual(a.fileHashes, fileHashes),
              )
            )
              return true;
            await api.recorder.append(
              ctx.threadId,
              "approval.requested",
              {
                toolCallId: ctx.toolCallId,
                tool: tool.name,
                args: input,
                fileHashes,
                summary: flag.summary(
                  input,
                  (id) => api.catalog.find((e) => e.id === id)?.name ?? id,
                ),
                outputs,
                ...(flag.makesStale && { outOfDate: madeStale(api.recorder.events(), outputs) }),
              },
              requestId,
            );
            return false;
          });
          if (duplicate)
            return { output: alreadyWaitingText(tool.name), isError: true, truncated: false };
        }
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        return { output: error.message, isError: true, truncated: false };
      }
      return {
        output: heldText(ctx.toolCallId),
        isError: false,
        truncated: false,
        terminate: true,
      };
    },
  };
}
