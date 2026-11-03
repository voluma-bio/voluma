/** What the log says of the researcher's review: the agent loop's outputs and the marks placed on them. */
import type { Attached } from "./agent-events";
import type { RunEvent } from "./events";
import { outputsFold } from "./output-fold";

export function reviewState(events: readonly RunEvent[]) {
  return { outputs: outputsFold(events), marks: marksOf(events) };
}

type Placed = Extract<RunEvent, { type: "mark.placed" }>["payload"];

/**
 * Every mark the log ever held, by id, in the order first placed, with whether it was deleted
 * since: `mark.placed` makes one or, from its author, replaces it; the author's `mark.deleted`
 * flags it. Another person's write to it changes nothing. `by` keeps only that person's writes
 * (their own view of ids they placed), so a mark someone else placed under the same id is not theirs.
 */
export function markStatesOf(
  events: readonly RunEvent[],
  by?: string,
): Map<string, { mark: Placed; deleted: boolean; seq: number }> {
  const marks = new Map<string, { mark: Placed; deleted: boolean; seq: number }>();
  for (const e of events) {
    if (e.type === "mark.placed" && (by === undefined || e.payload.by === by)) {
      const had = marks.get(e.payload.id);
      if (!had || had.mark.by === e.payload.by)
        marks.set(e.payload.id, { mark: e.payload, deleted: false, seq: e.seq });
    } else if (e.type === "mark.deleted" && (by === undefined || e.payload.by === by)) {
      const had = marks.get(e.payload.id);
      if (had?.mark.by === e.payload.by) had.deleted = true;
    }
  }
  return marks;
}

/** What the caller's previous messages froze of each mark, and the change that message told. */
export type ToldMark = { mark: Attached["mark"]; change: Attached["change"] };

/**
 * What main was last told of each mark `by` placed: the state their latest message naming it
 * froze (`person.message` attached), by mark id.
 */
export function toldMarks(events: readonly RunEvent[], by: string): Map<string, ToldMark> {
  const own = markStatesOf(events, by);
  const told = new Map<string, ToldMark>();
  for (const e of events)
    if (e.type === "person.message")
      for (const a of e.payload.attached ?? [])
        if (a.mark.id && own.has(a.mark.id))
          told.set(a.mark.id, { mark: a.mark, change: a.change });
  return told;
}

/** Key order is not meaning: stored JSON may come back reordered. */
export const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

/**
 * What to tell main of a mark now, against what it was last told (`toldMarks`): `place` for a mark
 * never told, or placed again after a told delete; `move` when a told mark's position, plane or
 * shape (its note too) changed; `delete` for a told mark deleted since; undefined when there is
 * nothing new (unchanged, or deleted though main never saw it).
 */
export function changeOf(
  current: { mark: Attached["mark"]; deleted: boolean },
  told: ToldMark | undefined,
): Attached["change"] | undefined {
  const toldLive = told !== undefined && told.change !== "delete";
  if (current.deleted) return toldLive ? "delete" : undefined;
  if (!toldLive) return "place";
  const { mark, world, plane } = current.mark;
  return canon([mark, world, plane]) === canon([told.mark.mark, told.mark.world, told.mark.plane])
    ? undefined
    : "move";
}

/** The researchers' marks the log holds now, by id, in the order first placed. */
export function marksOf(events: readonly RunEvent[]): Map<string, Placed> {
  const marks = new Map<string, Placed>();
  for (const [id, m] of markStatesOf(events)) if (!m.deleted) marks.set(id, m.mark);
  return marks;
}
