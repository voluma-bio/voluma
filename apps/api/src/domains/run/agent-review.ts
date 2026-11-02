/**
 * What the API reads from an agent-loop run's log to take a researcher's words (`corrections.ts`):
 * the marks a message attaches, frozen from the stored `mark.placed` events, and the writes a
 * claim has not seen by the time it ends. Pure functions of the log; nothing here writes.
 */
import type { Attached } from "@voluma/contracts/agent-events";
import type { RunEvent } from "@voluma/contracts/events";
import { outputsFold } from "@voluma/contracts/output-fold";
import { markStatesOf } from "@voluma/contracts/review-state";
import { HTTPException } from "hono/http-exception";

/**
 * The marks a message names, as the log holds them now (the browser sends ids, never geometry),
 * from the caller's own writes only. `delete` once the caller deleted it; `move` when main has
 * seen an earlier state of this mark (a previous message froze it), with `was` that state, which
 * equals the mark when it is sent again unmoved; else `place`. `version` is the mark's output's
 * latest. 404 for an id the caller did not place.
 */
export function freezeAttached(
  log: readonly RunEvent[],
  userId: string,
  markIds: readonly string[],
): Attached[] {
  const own = markStatesOf(log, userId);
  const told = new Map<string, Attached["mark"]>();
  for (const e of log)
    if (e.type === "person.message")
      for (const a of e.payload.attached ?? []) if (a.mark.id) told.set(a.mark.id, a.mark);
  const outputs = outputsFold(log).byId;
  return [...new Set(markIds)].map((id) => {
    const held = own.get(id);
    if (!held) throw new HTTPException(404, { message: "Mark not found." });
    const { by: _by, ...state } = held.mark;
    const version = outputs.get(state.output)?.latest?.version;
    if (version === undefined)
      throw new HTTPException(409, { message: "That output has no version yet." });
    const mark = { ...state, id } satisfies Attached["mark"];
    if (held.deleted) return { change: "delete", mark, version };
    const before = told.get(id);
    if (!before) return { change: "place", mark, version };
    return { change: "move", mark, was: { world: before.world, plane: before.plane }, version };
  });
}

/** The columns `lateResearcherWrite` reads; `payload` only of `thread.started`. */
export type LateRow = { id: string; type: string; seq: number; threadId: string; payload: unknown };

/**
 * The id of the first researcher write (a message, a yes or a no) that the ending claim never saw,
 * or null. "Saw" is `readSeq`, the runner's view when it decided to end (a gap fill puts a write
 * stored just before the root's end after it); an older runner sends none, and the root's latest
 * end stands in. Raw rows only: the caller may not parse the log (`report` must not throw).
 */
export function lateResearcherWrite(rows: readonly LateRow[], readSeq: number | undefined) {
  const roots = new Set(
    rows.flatMap((r) =>
      r.type === "thread.started" &&
      (r.payload as { parentThreadId?: unknown } | null)?.parentThreadId === null
        ? [r.threadId]
        : [],
    ),
  );
  // A write before the latest `run.reopened` already reopened the run: a reclaim must not do it twice.
  const reopenedAt = Math.max(
    0,
    ...rows.filter((r) => r.type === "run.reopened").map((r) => r.seq),
  );
  const seen = Math.max(
    reopenedAt,
    readSeq ??
      Math.max(
        0,
        ...rows.filter((r) => r.type === "thread.ended" && roots.has(r.threadId)).map((r) => r.seq),
      ),
  );
  if (seen === 0 && readSeq === undefined) return null;
  return (
    rows.find(
      (r) =>
        r.seq > seen &&
        (r.type === "person.message" ||
          r.type === "approval.given" ||
          r.type === "approval.declined"),
    )?.id ?? null
  );
}
