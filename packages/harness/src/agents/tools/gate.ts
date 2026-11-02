/**
 * The review gate. While the run is reviewing (`AgentLog.reviewing`), main's call to a tool that
 * changes results (`Tool.changesResults`) is not run: code writes `approval.requested` and answers
 * the call "held", and the turn ends (`terminate`; the other calls of the batch follow it through
 * `endsBatch`). The held call lives in the log and needs no claim; the researcher's yes starts the
 * stored call as a job (`loop.ts`, `startApproved`). The gate is on the tool, not in a role file,
 * and only main is gated: a worker also has `report_output`, and its limit is `outputs`.
 */

import { approvalRequestId } from "@voluma/contracts/agents";
import type { Tool } from "../../tools/tool";
import { madeStale, outputsNamed, summaryOf } from "../approvals";
import type { AgentsApi } from "./coordination";
import { Refusal } from "./refusal";

export const heldText = (toolCallId: string) =>
  `Held for the researcher (approval ${toolCallId}). Your turn ends; the answer arrives as a delivery.`;

export interface GateDeps {
  api: AgentsApi;
  /** The sha256 of a file where the thread's sandbox has it mounted. */
  hashIn(threadId: string, path: string, signal: AbortSignal): Promise<string>;
}

/** The names of the tools that carry the flag among `tools`. */
export const gatedNames = (tools: readonly Tool[]) =>
  new Set(tools.filter((t) => t.changesResults).map((t) => t.name));

export function gate(tool: Tool, { api, hashIn }: GateDeps): Tool {
  const flag = tool.changesResults;
  if (!flag) return tool;
  return {
    ...tool,
    async execute(input, ctx) {
      if (ctx.agent?.role !== "main" || !api.log().reviewing) return tool.execute(input, ctx);
      const requestId = approvalRequestId(ctx.threadId, ctx.toolCallId);
      try {
        // A preflight takes the run's section itself when it reads the log to decide.
        if (!api.log().written.has(requestId)) {
          await flag.preflight(input, ctx);
          const fileHashes: Record<string, string> = {};
          for (const f of flag.files?.(input, ctx) ?? [])
            fileHashes[f.key] = await hashIn(ctx.threadId, f.path, ctx.signal);
          await api.section(async () => {
            await api.recorder.append(
              ctx.threadId,
              "approval.requested",
              {
                toolCallId: ctx.toolCallId,
                tool: tool.name,
                args: input,
                fileHashes,
                summary: summaryOf(
                  tool.name,
                  input,
                  (id) => api.catalog.find((e) => e.id === id)?.name ?? id,
                ),
                ...(tool.name !== "keep_output" && {
                  outOfDate: madeStale(api.recorder.events(), outputsNamed(tool.name, input)),
                }),
              },
              requestId,
            );
          });
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
