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
import { useEffect, useMemo, useState } from "react";

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
  // A focused label has no extent in the run's data: find its middle on the grid.
  const focusLabels = grid.state === "ready" ? grid.focusLabels : undefined;
  const [labelsFocus, setLabelsFocus] = useState<{ for: typeof focusLabels; at?: Zyx }>();
  useEffect(() => {
    if (!focusLabels) return;
    const abort = new AbortController();
    labelsMiddle(focusLabels, abort.signal)
      .then((at) => setLabelsFocus({ for: focusLabels, at }))
      .catch(() => {});
    return () => abort.abort();
  }, [focusLabels]);
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
      focus={grid.focus ?? (labelsFocus?.for === focusLabels ? labelsFocus?.at : undefined)}
      notes={grid.notes}
    />
  );
}
