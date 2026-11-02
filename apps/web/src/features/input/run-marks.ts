/**
 * Your marks on a run of the agent loop, kept in its log: `mark.placed` makes or replaces one
 * (same id, same author), `mark.deleted` takes the author's away, and everyone who opens the run
 * sees them. A write shows at once and is dropped from `pending` when the stream carries it back.
 * The wire shape is `markPlacedSchema`, which also holds the mark in world mm with its pane's
 * frame, for sending it to main as a correction.
 *
 * Every change of yours waits for your next message to main (`changes`), by the API's own rule
 * (`toldMarks`, `changeOf`): your marks against what your last message naming each froze. A change
 * undone (`discard`) is no change. A message waits for the writes of the marks it names
 * (`settled`): the API freezes them from the log.
 */
import { ApiError, deleteMark, placeMark } from "@voluma/api-client";
import {
  markPlacedSchema,
  type PlaceMarkRequest,
  placeMarkRequestSchema,
} from "@voluma/contracts/agent-events";
import type { RunEvent } from "@voluma/contracts/events";
import type { Volume } from "@voluma/contracts/review";
import { changeOf, markStatesOf, marksOf, toldMarks } from "@voluma/contracts/review-state";
import { markPoints, worldOf } from "@voluma/viewer/grid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gridKeyOf, type MarkChange, type MarkStore, type YourMark } from "./marks-panel";
import { NotSent } from "./message-send";

type Placed = Extract<RunEvent, { type: "mark.placed" }>["payload"];

/** A write as the log will hold it once the API adds its author. */
const asLogged = (body: PlaceMarkRequest, by: string): Placed =>
  markPlacedSchema.parse({ ...body, by });

const yours = (p: Placed, me: string): YourMark => ({
  id: p.id,
  tag: p.tag,
  taskId: p.output,
  gridKey: p.gridKey,
  volumeId: p.volume,
  mark: p.mark,
  plane: p.plane,
  theirs: p.by !== me,
});

/** A mark write that failed: the message naming the mark waits. */
const UNSAVED = "A mark of yours wasn't saved, so the message wasn't sent. Try again.";

/**
 * The marks of a run whose log is `events`, for the outputs review (`useMarking`'s store). A mark
 * whose image the run has since replaced is left out: its voxels belong to the old bytes.
 */
export function useRunMarks({
  run,
  me,
  events,
  volumes,
  reopen,
}: {
  run: { id: string; example: boolean };
  me: string;
  events: readonly RunEvent[];
  volumes: readonly Volume[];
  /** Reconnects the stream, to catch what a write added to the log. */
  reopen: () => void;
}): MarkStore & {
  error: string | undefined;
  /** Resolves once the writes of these marks are in the log; rejects when one failed. */
  settled: (ids: readonly string[]) => Promise<void>;
} {
  const logged = useMemo(() => marksOf(events), [events]);
  // id → the mark as written and not yet seen in the log; null for a deletion.
  const [pending, setPending] = useState<ReadonlyMap<string, Placed | null>>(new Map());
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (pending.size === 0) return;
    const seen = [...pending].filter(([id, m]) => {
      const l = logged.get(id);
      return m === null ? !l : l && JSON.stringify(l.mark) === JSON.stringify(m.mark);
    });
    if (seen.length)
      setPending((had) => {
        const next = new Map(had);
        for (const [id] of seen) next.delete(id);
        return next;
      });
  }, [logged, pending]);

  const gridKeys = useMemo(() => new Set(volumes.map(gridKeyOf)), [volumes]);
  // Every mark as you see it now: the log's, with your writes not back yet.
  const all = useMemo(() => {
    const now = new Map([...logged].map(([id, p]) => [id, yours(p, me)] as const));
    for (const [id, m] of pending)
      if (m) now.set(id, yours(m, me));
      else now.delete(id);
    return now;
  }, [logged, pending, me]);
  const marks = useMemo(
    () => [...all.values()].filter((m) => gridKeys.has(m.gridKey)),
    [all, gridKeys],
  );
  const told = useMemo(() => toldMarks(events, me), [events, me]);
  // Deleted marks keep their tags: a message may name them.
  const tags = useMemo(
    () => [
      ...new Set([
        ...events.flatMap((e) => (e.type === "mark.placed" ? [e.payload.tag] : [])),
        ...[...pending.values()].flatMap((m) => (m ? [m.tag] : [])),
      ]),
    ],
    [events, pending],
  );
  // A mark on an image the run has since replaced is gone from the panes, and from the next message.
  const changes = useMemo(() => {
    const now = new Map(
      [...markStatesOf(events, me)].map(([id, m]) => [id, { mark: m.mark, deleted: m.deleted }]),
    );
    for (const [id, m] of pending)
      if (m) now.set(id, { mark: m, deleted: false });
      else {
        const had = now.get(id);
        if (had) now.set(id, { ...had, deleted: true });
      }
    const out: MarkChange[] = [];
    for (const [id, m] of now) {
      const change = gridKeys.has(m.mark.gridKey) ? changeOf(m, told.get(id)) : undefined;
      if (change) out.push({ id, tag: m.mark.tag, output: m.mark.output, change });
    }
    return out;
  }, [events, me, pending, told, gridKeys]);

  const latest = useRef({ volumes, run, reopen, me });
  latest.current = { volumes, run, reopen, me };
  // Each mark's writes go one after another, so the log ends with the last (a point, then its
  // note); a run lock can hold one while the next would overtake it. Each settles true when saved.
  const queues = useRef(new Map<string, Promise<boolean>>());
  const write = useCallback((id: string, next: Placed | null, send: () => Promise<void>) => {
    setError(undefined);
    setPending((had) => new Map(had).set(id, next));
    const sent = (queues.current.get(id) ?? Promise.resolve(true)).then(send).then(
      () => {
        latest.current.reopen();
        return true;
      },
      (e: unknown) => {
        // Only this write's own pending entry goes; a later write's stays.
        setPending((had) => {
          if (had.get(id) !== next) return had;
          const rest = new Map(had);
          rest.delete(id);
          return rest;
        });
        setError(
          (e instanceof ApiError && e.serverMessage) || "Couldn't save the mark. Try again.",
        );
        return false;
      },
    );
    queues.current.set(id, sent);
    void sent.then(() => {
      if (queues.current.get(id) === sent) queues.current.delete(id);
    });
  }, []);
  const settled = useCallback(async (ids: readonly string[]) => {
    const saved = await Promise.all(ids.map((id) => queues.current.get(id) ?? true));
    if (!saved.every(Boolean)) throw new NotSent(UNSAVED);
  }, []);
  const place = useCallback(
    (m: YourMark) => {
      const { volumes: all, run: r } = latest.current;
      const volume = all.find((v) => v.id === m.volumeId);
      if (!volume) return;
      const body: PlaceMarkRequest = {
        id: m.id,
        output: m.taskId,
        tag: m.tag,
        volume: m.volumeId,
        gridKey: m.gridKey,
        mark: m.mark,
        world: markPoints(m.mark).map((p) => worldOf(p, volume.affine)),
        plane: m.plane && {
          view: m.plane.view,
          normal: m.plane.normal,
          right: m.plane.right,
          down: m.plane.down,
        },
      };
      write(m.id, asLogged(body, latest.current.me), () => placeMark(r.id, body));
    },
    [write],
  );
  const erase = useCallback(
    (id: string) => write(id, null, () => deleteMark(latest.current.run.id, id)),
    [write],
  );
  const latestTold = useRef(told);
  latestTold.current = told;
  // Puts a mark back as main was last told of it; one no message carried goes.
  const discard = useCallback(
    (id: string) => {
      const t = latestTold.current.get(id);
      if (!t || t.change === "delete") return erase(id);
      // The frozen copy is stored JSON: parsed back into the request it was placed with.
      const body = placeMarkRequestSchema.parse({ ...t.mark, id });
      const { run: r, me } = latest.current;
      write(id, asLogged(body, me), () => placeMark(r.id, body));
    },
    [write, erase],
  );
  return { marks, tags, full: false, place, erase, error, changes, discard, settled };
}
