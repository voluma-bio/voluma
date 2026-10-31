/**
 * The scan review's main area: the task in view on its own analysis grid in Andrew's grid viewer
 * (3D and three slices through one crosshair), with the blocks the task names drawn on it, from
 * the run's converted assets. Loaded lazily, with three.js. The viewer remounts only for another
 * grid; structure display changes redraw in place.
 */
import { reviewAssetUrl } from "@voluma/api-client";
import type { Focus, ReviewAssets, ReviewTask, Revision } from "@voluma/contracts/review";
import { EmptyState } from "@voluma/ui";
import {
  GridViewer,
  labelsMiddle,
  type StructureDisplay,
  taskGrid,
  tokenColor,
  type Zyx,
} from "@voluma/viewer/grid";
import { useEffect, useMemo, useRef, useState } from "react";

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
  /** The selected item's place: each new object moves the crosshair there once. */
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
        token: tokenColor,
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
  // A new object per item selection or found voxel, so the crosshair moves then and not when
  // display settings change.
  const at =
    grid.state === "ready"
      ? (grid.focus ?? (labelsFocus?.for === labelsKey ? labelsFocus?.at : undefined))
      : undefined;
  const atKey = at?.join();
  const target = useMemo(() => (at ? { at } : undefined), [focus, atKey]);
  if (grid.state !== "ready")
    return (
      <div
        className="grid h-full place-content-center p-6"
        role={grid.state === "failed" ? "alert" : "status"}
      >
        <EmptyState title={grid.state === "preparing" ? "Preparing the views" : "No views"}>
          {grid.message}
        </EmptyState>
      </div>
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
