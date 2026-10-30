/**
 * The imaging panel of a task: the task's own analysis grid in the grid viewer, with the blocks
 * it names drawn on it, from the run's converted assets. Loaded lazily, with three.js. It turns
 * a pane's capture into a screenshot's view state and reopens one on its own grid only.
 */
import { reviewAssetUrl } from "@voluma/api-client";
import type { Focus, ReviewAssets, ReviewTask, Revision } from "@voluma/contracts/review";
import type { GridViewState } from "@voluma/contracts/snapshot";
import {
  GridViewer,
  labelsMiddle,
  type StructureDisplay,
  taskGrid,
  type ViewerState,
  type Zyx,
} from "@voluma/viewer/grid";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function TaskViewer({
  runId,
  revision,
  task,
  assets,
  display,
  focus,
  restore,
  onCapture,
  footer,
}: {
  runId: string;
  revision: Revision;
  task: ReviewTask;
  assets: Record<string, ReviewAssets>;
  display: StructureDisplay;
  focus?: Focus;
  /** A screenshot to reopen; its focus is `focus`, which then highlights without moving. */
  restore?: GridViewState;
  onCapture?(state: GridViewState, png: { base64: string; width: number; height: number }): void;
  footer?: ReactNode;
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
  const target = useMemo(() => (at && !restore ? { at } : undefined), [focus, atKey, restore]);
  // Display settings are kept across revisions; a screenshot names only this one's.
  const shown = new Set([...revision.structures, ...revision.surfaces].map((s) => s.id));
  const shape = grid.state === "ready" ? grid.scene.shapeZyx : undefined;
  const restoreProblem =
    restore &&
    grid.state === "ready" &&
    (restore.gridId !== grid.gridId
      ? "This screenshot was taken on another grid, so its view can't be reopened."
      : restore.point.some((p, i) => p >= shape![i]!)
        ? "This screenshot's crosshair is outside this grid, so its view can't be reopened."
        : undefined);
  const restoreState = useMemo<ViewerState | undefined>(
    () =>
      restore && {
        pane: restore.kind === "3d" ? "3d" : restore.plane,
        point: restore.point,
        contrast: { low: restore.window.lower, high: restore.window.upper },
        view:
          restore.kind === "3d"
            ? { camera: restore.camera }
            : { zoom: restore.zoom, center: restore.center },
      },
    [restore],
  );
  if (grid.state !== "ready")
    return (
      <section className="viewer-workspace" aria-label="Imaging workspace">
        <div className="view-empty" role={grid.state === "failed" ? "alert" : "status"}>
          {grid.message}
        </div>
        {footer}
      </section>
    );
  return (
    <GridViewer
      key={grid.scene.image.base}
      scene={grid.scene}
      title={grid.name}
      focus={target}
      notes={restoreProblem ? [restoreProblem, ...grid.notes] : grid.notes}
      restore={restoreProblem ? undefined : restoreState}
      footer={footer}
      onCapture={
        onCapture &&
        ((state, png) => {
          const common = {
            version: 2 as const,
            gridId: grid.gridId,
            viewport: { width: png.width, height: png.height },
            point: [...state.point] as [number, number, number],
            window: { lower: state.contrast.low, upper: state.contrast.high },
            structures: Object.entries(display)
              .filter(([id]) => shown.has(id))
              .map(([structureId, d]) => ({ structureId, ...d })),
            focus,
          };
          onCapture(
            "camera" in state.view
              ? { ...common, kind: "3d", camera: state.view.camera }
              : {
                  ...common,
                  kind: "slice",
                  plane: state.pane as "axial" | "coronal" | "sagittal",
                  zoom: state.view.zoom,
                  center: state.view.center,
                },
            png,
          );
        })
      }
    />
  );
}
