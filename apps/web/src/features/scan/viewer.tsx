/**
 * The scan review's main area: the task in view on its own analysis grid in Andrew's grid viewer
 * (3D and three slices through one crosshair), with the blocks the task names drawn on it, from
 * the run's converted assets. Loaded lazily, with three.js. The viewer remounts only for another
 * grid; structure display changes redraw in place. The marking tools sit on the viewer's bar;
 * your marks on this grid's image are drawn, and a new one is named by that image's id.
 */
import { reviewAssetUrl } from "@voluma/api-client";
import type { Focus, ReviewAssets, ReviewTask, Revision } from "@voluma/contracts/review";
import { EmptyState, SegmentedControl } from "@voluma/ui";
import {
  type GridMark,
  GridViewer,
  type GridViewerHandle,
  labelsMiddle,
  type MarkTool,
  type ShownMark,
  type StructureDisplay,
  taskGrid,
  tokenColor,
  type Zyx,
} from "@voluma/viewer/grid";
import { type Ref, useEffect, useMemo, useRef, useState } from "react";
import type { YourMark } from "./marks-panel";

/** The tools, each with the key that picks it (`scan-page.tsx` listens). */
export const TOOLS: { value: MarkTool | "navigate"; label: string; keys: string }[] = [
  { value: "navigate", label: "Navigate", keys: "Escape" },
  { value: "point", label: "Point", keys: "P" },
  { value: "box", label: "Box", keys: "B" },
  { value: "line", label: "Line", keys: "L" },
  { value: "outline", label: "Lasso", keys: "O" },
];

export function TaskViewer({
  runId,
  revision,
  task,
  assets,
  display,
  focus,
  tool,
  onTool,
  marks,
  selected,
  jump,
  onMark,
  viewer,
}: {
  runId: string;
  revision: Revision;
  task: ReviewTask;
  assets: Record<string, ReviewAssets>;
  display: StructureDisplay;
  /** The selected item's place: each new object moves the crosshair there once. */
  focus?: Focus;
  tool: MarkTool | null;
  onTool: (tool: MarkTool | null) => void;
  marks: readonly YourMark[];
  selected: string | undefined;
  /** A mark picked in Marks: each new object moves the crosshair there once. */
  jump?: { at: Zyx; volumeId: string };
  /** A new mark, on the image volume `volumeId`. */
  onMark: (mark: GridMark, volumeId: string) => void;
  viewer: Ref<GridViewerHandle>;
}) {
  const [labels, setLabels] = useState(false);
  const grid = useMemo(
    () =>
      taskGrid({
        revision,
        task,
        assets,
        display,
        labels,
        focus,
        // The zarr reader resolves level paths against this, so it is absolute.
        assetBase: (sha256) =>
          new URL(reviewAssetUrl(runId, sha256, "x").slice(0, -1), location.href).href,
        token: tokenColor,
      }),
    [runId, revision, task, assets, display, labels, focus],
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
  // The crosshair goes to whichever came last: the item's place or a picked mark.
  const imageId = grid.state === "ready" ? grid.imageId : undefined;
  const [aim, setAim] = useState(target);
  useEffect(() => setAim(target), [target]);
  useEffect(() => {
    if (jump && jump.volumeId === imageId) setAim({ at: jump.at });
  }, [jump, imageId]);
  const shown = useMemo<ShownMark[]>(
    () =>
      marks
        .filter((m) => m.mark.volumeId === imageId)
        .map(({ id, tag, mark: { volumeId: _, ...mark } }) => ({
          id,
          tag,
          mark: mark as GridMark,
          by: "you",
          selected: id === selected,
        })),
    [marks, imageId, selected],
  );
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
      focus={aim}
      notes={grid.notes}
      tool={tool}
      marks={shown}
      onMark={(mark) => onMark(mark, grid.imageId)}
      ref={viewer}
    >
      <SegmentedControl
        label="Marking tool"
        options={TOOLS}
        value={tool ?? "navigate"}
        onValueChange={(v) => onTool(v === "navigate" ? null : v)}
      />
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />
        Labels
      </label>
    </GridViewer>
  );
}
