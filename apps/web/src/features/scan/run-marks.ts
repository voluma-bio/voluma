/**
 * Your marks on a run of the agent loop, kept in its log: `mark.placed` makes or replaces one
 * (same id, same author), `mark.deleted` takes the author's away, and everyone who opens the run
 * sees them. A write shows at once and is dropped from `pending` when the stream carries it back.
 * The wire shape is `markPlacedSchema`, which also holds the mark in world mm with its pane's
 * frame, for sending it to main as a correction.
 */
import { deleteMark, placeMark } from "@voluma/api-client";
import type { PlaceMarkRequest } from "@voluma/contracts/agent-events";
import type { RunEvent } from "@voluma/contracts/events";
import type { Volume } from "@voluma/contracts/review";
import { markPoints, worldOf } from "@voluma/viewer/grid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gridKeyOf, type MarkStore, type YourMark } from "./marks-panel";

type Placed = Extract<RunEvent, { type: "mark.placed" }>["payload"];

/** The marks the log holds, in the order they were first placed. */
function foldMarks(events: readonly RunEvent[]): Map<string, Placed> {
  const marks = new Map<string, Placed>();
  for (const e of events) {
    if (e.type === "mark.placed") {
      const had = marks.get(e.payload.id);
      if (!had || had.by === e.payload.by) marks.set(e.payload.id, e.payload);
    } else if (e.type === "mark.deleted" && marks.get(e.payload.id)?.by === e.payload.by)
      marks.delete(e.payload.id);
  }
  return marks;
}

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
}): MarkStore & { error: string | undefined } {
  const logged = useMemo(() => foldMarks(events), [events]);
  // id → the mark as written and not yet seen in the log; null for a deletion.
  const [pending, setPending] = useState<ReadonlyMap<string, YourMark | null>>(new Map());
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (pending.size === 0) return;
    const seen = [...pending].filter(([id, m]) => {
      const l = logged.get(id);
      return m === null ? !l : l && JSON.stringify(yours(l, me).mark) === JSON.stringify(m.mark);
    });
    if (seen.length)
      setPending((had) => {
        const next = new Map(had);
        for (const [id] of seen) next.delete(id);
        return next;
      });
  }, [logged, pending, me]);

  const gridKeys = useMemo(() => new Set(volumes.map(gridKeyOf)), [volumes]);
  const marks = useMemo(() => {
    const all = new Map([...logged].map(([id, p]) => [id, yours(p, me)] as const));
    for (const [id, m] of pending)
      if (m) all.set(id, m);
      else all.delete(id);
    return [...all.values()].filter((m) => gridKeys.has(m.gridKey));
  }, [logged, pending, gridKeys, me]);

  const latest = useRef({ volumes, run, reopen });
  latest.current = { volumes, run, reopen };
  // Each mark's writes go one after another, so the log ends with the last (a point, then its
  // note); a run lock can hold one while the next would overtake it.
  const queues = useRef(new Map<string, Promise<void>>());
  const write = useCallback((id: string, next: YourMark | null, send: () => Promise<void>) => {
    setError(undefined);
    setPending((had) => new Map(had).set(id, next));
    const sent = (queues.current.get(id) ?? Promise.resolve()).then(send).then(
      () => latest.current.reopen(),
      (e: unknown) => {
        // Only this write's own pending entry goes; a later write's stays.
        setPending((had) => {
          if (had.get(id) !== next) return had;
          const rest = new Map(had);
          rest.delete(id);
          return rest;
        });
        setError(e instanceof Error && e.message ? e.message : "Couldn't save the mark.");
      },
    );
    queues.current.set(id, sent);
    void sent.then(() => {
      if (queues.current.get(id) === sent) queues.current.delete(id);
    });
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
      write(m.id, m, () => placeMark(r.id, body));
    },
    [write],
  );
  const erase = useCallback(
    (id: string) => write(id, null, () => deleteMark(latest.current.run.id, id)),
    [write],
  );
  return { marks, full: false, place, erase, error };
}
