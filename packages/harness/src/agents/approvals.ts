/**
 * What a held call says it would do: the summary the researcher reads on an `approval.requested`,
 * written by code from the call and the log, never by main. The fold of requests and answers is
 * `approvalRecords` (`contracts/agents.ts`).
 */
import type { RunEvent } from "@voluma/contracts/events";
import { outputsFold } from "@voluma/contracts/output-fold";

/** The outputs made from `ids` through latest versions, `ids` themselves left out: what a new version of them makes out of date. */
export function madeStale(events: readonly RunEvent[], ids: readonly string[]): string[] {
  const fold = outputsFold(events);
  const mapOf = (id: string) => fold.labels.get(id) ?? id;
  const named = new Set(ids.map(mapOf));
  const stale = new Set<string>();
  const queue = [...named];
  for (let from = queue.pop(); from !== undefined; from = queue.pop()) {
    for (const o of fold.outputs) {
      if (named.has(o.id) || stale.has(o.id)) continue;
      if (o.latest?.madeFrom.some((l) => mapOf(l.id) === from)) {
        stale.add(o.id);
        queue.push(o.id);
      }
    }
  }
  return [...stale];
}

/** The outputs a gated call names: what it changes, for the summary and for leaving them to the researcher when declined. */
export function outputsNamed(tool: string, args: unknown): string[] {
  const a = (args ?? {}) as { ids?: string[]; outputs?: string[]; id?: string };
  if (tool === "keep_output") return a.ids ?? [];
  if (tool === "start_worker") return a.outputs ?? [];
  if (tool === "report_output") return a.id ? [a.id] : [];
  return [];
}

/**
 * What the call would do, in the researcher's words: outputs by their catalog name, no worker
 * names or ids. What it makes out of date is `outOfDate` on the request, which the card lists.
 */
export function summaryOf(tool: string, args: unknown, titleOf: (id: string) => string): string {
  const a = (args ?? {}) as { reason?: string };
  const what = outputsNamed(tool, args).map(titleOf).join(", ");
  switch (tool) {
    case "start_worker":
      return `Start an AI worker to redo ${what}.`;
    case "report_output":
      return `Publish a new version of ${what}.`;
    case "keep_output":
      return `Keep ${what} as ${outputsNamed(tool, args).length === 1 ? "it is" : "they are"}${a.reason ? `: ${a.reason}` : ""}.`;
    case "change_outputs":
      return `Change which outputs the run delivers${a.reason ? `: ${a.reason}` : ""}.`;
    default:
      return `Run ${tool}.`;
  }
}
