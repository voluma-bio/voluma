/**
 * What a held call would make out of date, for the `outOfDate` list of an `approval.requested`
 * (written by code from the call and the log, never by main). The summary and the outputs a call
 * names come from its tool (`Tool.changesResults`); the fold of requests and answers is
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
