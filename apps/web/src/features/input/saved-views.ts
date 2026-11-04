/**
 * The views saved of a run's outputs (`view.saved`, which the stream brings back), and saving and
 * opening one in the outputs review. Example runs can't be changed, so they have no Save view.
 */
import { useMutation } from "@tanstack/react-query";
import { ApiError, saveView } from "@voluma/api-client";
import type { RunEvent } from "@voluma/contracts/events";
import { type OutputRow, shownOf } from "@voluma/run-view";
import { type QuadState, readView, storedWords, storeView } from "@voluma/viewer/grid";
import { useEffect, useRef, useState } from "react";

/** A view saved of an output: its title ("View 2"), when, and how its planes lay in words. */
export type SavedView = {
  id: string;
  seq: number;
  output: string;
  view: unknown;
  title: string;
  time: string;
  words?: string;
};

/** The run's saved views, oldest first, each numbered among its output's. */
export function savedViews(events: readonly RunEvent[]): SavedView[] {
  const count = new Map<string, number>();
  return events.flatMap((e) => {
    if (e.type !== "view.saved") return [];
    const n = (count.get(e.payload.output) ?? 0) + 1;
    count.set(e.payload.output, n);
    return [
      {
        id: e.id,
        seq: e.seq,
        output: e.payload.output,
        view: e.payload.view,
        title: `View ${n}`,
        time: new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        words: storedWords(e.payload.view),
      },
    ];
  });
}

/** Saving a view and opening one; `all` is the run's (`savedViews`). */
export function useSavedViews(
  run: { id: string; example: boolean },
  all: readonly SavedView[],
  reopen: () => void,
) {
  const [restore, setRestore] = useState<{ grid: string; state: QuadState }>();
  const [shown, setShown] = useState<string>();
  const [error, setError] = useState<string>();
  const mutation = useMutation<void, Error, { output: string; view: ReturnType<typeof storeView> }>(
    {
      mutationFn: (body) => saveView(run.id, body),
      onMutate: () => setError(undefined),
      onSuccess: reopen,
      onError: (e) =>
        setError(
          e instanceof ApiError && e.serverMessage ? e.serverMessage : "Couldn't save the view.",
        ),
    },
  );
  // The newest saved view of what was just saved is the one shown.
  const pendingFor = useRef<string>(undefined);
  useEffect(() => {
    const output = pendingFor.current;
    if (!output) return;
    const newest = all.filter((v) => v.output === output).at(-1);
    if (newest) setShown(newest.id);
  }, [all]);
  return {
    shown,
    error,
    restore,
    save: run.example
      ? undefined
      : (row: OutputRow, state: QuadState, grid: string) => {
          pendingFor.current = row.id;
          mutation.mutate({ output: row.id, view: storeView(state, grid, shownOf(row)) });
        },
    open: (v: SavedView) => {
      const grid = (v.view as { review?: { grid?: string } }).review?.grid;
      const state = grid ? readView(v.view, grid) : undefined;
      if (!grid || !state) {
        setError("This view can't be opened here.");
        return;
      }
      setError(undefined);
      setShown(v.id);
      setRestore({ grid, state });
    },
  };
}
