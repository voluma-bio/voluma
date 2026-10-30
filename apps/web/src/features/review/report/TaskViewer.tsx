/**
 * The imaging panel of a task: the task's own analysis grid in the grid viewer, with the blocks
 * it names drawn on it, from the run's converted assets. Loaded lazily, with three.js.
 */
import { reviewAssetUrl } from "@voluma/api-client";
import type { Focus, ReviewAssets, ReviewTask, Revision } from "@voluma/contracts/review";
import {
  GridViewer,
  labelsMiddle,
  type StructureDisplay,
  taskGrid,
  type Zyx,
} from "@voluma/viewer/grid";
import { useEffect, useMemo, useRef, useState } from "react";

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function TaskViewer({
  runId,
  revision,
  task,
  assets,
  display,
  focus,
}: {
  runId: string;
  revision: Revision;
  task: ReviewTask;
  assets: Record<string, ReviewAssets>;
  display: StructureDisplay;
  focus?: Focus;
}) {
  const grid = useMemo(
    () =>
      taskGrid({
        revision,
        task,
        assets,
        display,
        focus,
        // The zarr reader resolves level paths against this, so it is absolute.
        assetBase: (sha256) =>
          new URL(reviewAssetUrl(runId, sha256, "x").slice(0, -1), location.href).href,
        token,
      }),
    [runId, revision, task, assets, display, focus],
  );
  // A focused label has no extent in the run's data: find its middle on the grid. Keyed by
  // what it reads, since `grid` is rebuilt on every display change.
  const focusLabels = grid.state === "ready" ? grid.focusLabels : undefined;
  const labelsKey = focusLabels && `${focusLabels.source.base}|${focusLabels.labels.join()}`;
  const latestLabels = useRef(focusLabels);
  latestLabels.current = focusLabels;
  const [labelsFocus, setLabelsFocus] = useState<{ for: string; at?: Zyx }>();
  useEffect(() => {
    const wanted = latestLabels.current;
    if (!labelsKey || !wanted) return;
    const abort = new AbortController();
    labelsMiddle(wanted, abort.signal)
      .then((at) => setLabelsFocus({ for: labelsKey, at }))
      .catch(() => {});
    return () => abort.abort();
  }, [labelsKey]);
  // A new object per check selection (each "Show in viewer" click is a new `focus`) or found
  // voxel, so the crosshair moves then and not when display settings change.
  const at =
    grid.state === "ready"
      ? (grid.focus ?? (labelsFocus?.for === labelsKey ? labelsFocus?.at : undefined))
      : undefined;
  const atKey = at?.join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `at` is a new tuple each render; its voxel is `atKey`.
  const target = useMemo(() => (at ? { at } : undefined), [focus, atKey]);
  if (grid.state !== "ready")
    return (
      <section className="viewer-workspace" aria-label="Imaging workspace">
        <div className="view-empty" role={grid.state === "failed" ? "alert" : "status"}>
          {grid.message}
        </div>
      </section>
    );
  return (
    <GridViewer
      key={grid.scene.image.base}
      scene={grid.scene}
      title={grid.name}
      focus={target}
      notes={grid.notes}
    />
  );
}
