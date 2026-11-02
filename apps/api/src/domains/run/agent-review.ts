/**
 * What the API reads from an agent-loop run's log to take a researcher's words (`corrections.ts`):
 * the marks a message attaches, frozen from the stored `mark.placed` events, and the writes a
 * claim has not seen by the time it ends. Pure functions of the log; nothing here writes.
 */
import type { Attached } from "@voluma/contracts/agent-events";
import type { RunEvent } from "@voluma/contracts/events";
import { outputsFold } from "@voluma/contracts/output-fold";
import { HTTPException } from "hono/http-exception";

type Placed = Extract<RunEvent, { type: "mark.placed" }>;

const sameState = (a: Pick<Attached["mark"], "world" | "plane">, b: typeof a) =>
  JSON.stringify([a.world, a.plane]) === JSON.stringify([b.world, b.plane]);

/**
 * The marks a message names, as the log holds them now (the browser sends ids, never geometry).
 * `change`: `delete` once a `mark.deleted` follows the last placement; `move` when main was last
 * told of a different state (a previous message's freeze, else the first placement); else `place`.
 * `version` is the mark's output's latest. 404 for an id the caller did not place.
 */
export function freezeAttached(
  log: readonly RunEvent[],
  userId: string,
  markIds: readonly string[],
): Attached[] {
  const placed = new Map<string, Placed[]>();
  const deletedAt = new Map<string, number>();
  const told = new Map<string, Attached["mark"]>();
  for (const e of log) {
    if (e.type === "mark.placed")
      placed.set(e.payload.id, [...(placed.get(e.payload.id) ?? []), e]);
    else if (e.type === "mark.deleted") deletedAt.set(e.payload.id, e.seq);
    else if (e.type === "person.message")
      for (const a of e.payload.attached ?? []) if (a.mark.id) told.set(a.mark.id, a.mark);
  }
  const outputs = outputsFold(log).byId;
  return [...new Set(markIds)].map((id) => {
    const history = placed.get(id) ?? [];
    const last = history.at(-1);
    if (!last || last.payload.by !== userId)
      throw new HTTPException(404, { message: "Mark not found." });
    const { by: _by, ...state } = last.payload;
    const version = outputs.get(state.output)?.latest?.version;
    if (version === undefined)
      throw new HTTPException(409, { message: "That output has no version yet." });
    const mark = { ...state, id } satisfies Attached["mark"];
    if ((deletedAt.get(id) ?? 0) > last.seq) return { change: "delete", mark, version };
    const before = told.get(id) ?? history[0]?.payload ?? mark;
    // A first placement, or the state main was told of: nothing moved since.
    if (sameState(before, mark)) return { change: "place", mark, version };
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
