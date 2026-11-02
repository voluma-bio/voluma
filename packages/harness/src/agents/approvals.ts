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

/** "This makes out of date: tibia-grid, roi-iioc, 6 values." Empty when it makes nothing out of date. */
function knockOn(events: readonly RunEvent[], ids: readonly string[]): string {
  const byId = outputsFold(events).byId;
  const stale = madeStale(events, ids);
  const values = stale.filter((id) => byId.get(id)?.kind === "value");
  const others = stale.filter((id) => !values.includes(id));
  const list = [...others, ...(values.length > 0 ? [`${values.length} values`] : [])];
  return list.length > 0
    ? ` This makes out of date: ${list.join(", ")}.`
    : " It makes nothing out of date.";
}

/** The outputs a gated call names: what it changes, for the summary and for leaving them to the researcher when declined. */
export function outputsNamed(tool: string, args: unknown): string[] {
  const a = (args ?? {}) as { ids?: string[]; outputs?: string[]; id?: string };
  if (tool === "keep_output") return a.ids ?? [];
  if (tool === "start_worker") return a.outputs ?? [];
  if (tool === "report_output") return a.id ? [a.id] : [];
  return [];
}

export function summaryOf(events: readonly RunEvent[], tool: string, args: unknown): string {
  const a = (args ?? {}) as { name?: string; reason?: string };
  const ids = outputsNamed(tool, args);
  switch (tool) {
    case "start_worker":
      return `Start worker ${a.name} for ${ids.join(", ")}.${knockOn(events, ids)}`;
    case "report_output":
      return `Publish a new version of ${ids.join(", ")}.${knockOn(events, ids)}`;
    case "keep_output":
      return `Keep ${ids.join(", ")} as they are${a.reason ? `: ${a.reason}` : ""}. Whatever is made from them is current again.`;
    case "change_outputs":
      return `Change the run's final outputs${a.reason ? `: ${a.reason}` : ""}.`;
    default:
      return `Run ${tool}.`;
  }
}
