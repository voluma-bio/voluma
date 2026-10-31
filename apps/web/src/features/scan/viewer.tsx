/**
 * The scan review's main area: the task in view on its own analysis grid in Andrew's grid viewer
 * (3D and three slices through one crosshair), with the blocks the task names drawn on it, from
 * the run's converted assets. Loaded lazily, with three.js. Each grid gets its own viewer, kept
 * mounted and hidden while another grid is shown; structure display changes redraw in place.
 * The marking tools sit on the viewer's bar; your marks on this grid's image are drawn, and a
 * new one is named by that image's id. The page learns which grid is shown (`onShown`), since
 * marks and the picture belong to it.
 */
import { reviewAssetUrl } from "@voluma/api-client";
import { MAX_MARKS } from "@voluma/contracts/messages";
import type { Focus, ReviewAssets, ReviewTask, Revision } from "@voluma/contracts/review";
import { EmptyState, SegmentedControl } from "@voluma/ui";
import {
  type GridMark,
  type GridScene,
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
import { FULL, gridKeyOf, gridMark, type ShownGrid, TOOLS, type YourMark } from "./marks-panel";

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
  onJumped,
  onMark,
  onShown,
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
  /** A mark picked in Marks: it moves the crosshair once its grid is shown, then `onJumped`. */
  jump?: { at: Zyx; gridKey: string; taskId: string };
  onJumped: () => void;
  /** A new mark, on the image volume `volumeId`. */
  onMark: (mark: GridMark, volumeId: string, gridKey: string) => void;
  /** The mounted task and grid; undefined while no viewer is shown. */
  onShown: (shown: ShownGrid | undefined) => void;
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
  const image = revision.volumes.find((v) => v.id === imageId);
  const gridKey = image && gridKeyOf(image);
  // Readiness belongs to the grid that reported it; a kept viewer keeps reporting while hidden.
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const report = (key: string) => (r: boolean) =>
    setReady((had) => (had[key] === r ? had : { ...had, [key]: r }));
  const shownReady = !!gridKey && !!ready[gridKey];
  useEffect(
    () => onShown(gridKey ? { key: gridKey, taskId: task.id, ready: shownReady } : undefined),
    [gridKey, task.id, shownReady, onShown],
  );
  useEffect(() => () => onShown(undefined), [onShown]);
  const [aim, setAim] = useState({ gridKey, target });
  useEffect(() => setAim({ gridKey, target }), [gridKey, target]);
  useEffect(() => {
    if (!jump) return;
    if (jump.gridKey === gridKey) {
      setAim({ gridKey, target: { at: jump.at } });
      onJumped();
    } else if (jump.taskId === task.id) onJumped();
  }, [jump, gridKey, task.id, onJumped]);
  // A new grid mounts before effects run; never initialize it with the previous grid's voxel.
  const shownFocus = aim.gridKey === gridKey ? aim.target : target;
  const shown = useMemo(() => {
    const byGrid = new Map<string, ShownMark[]>();
    for (const m of marks) {
      const mark = gridMark(m.mark);
      if (!mark) continue;
      const on = byGrid.get(m.gridKey) ?? [];
      on.push({ id: m.id, tag: m.tag, mark, by: "you", selected: m.id === selected });
      byGrid.set(m.gridKey, on);
    }
    return byGrid;
  }, [marks, selected]);
  const full = marks.length >= MAX_MARKS;

  // Each grid shown keeps its viewer, hidden while another grid is shown, so going back is
  // instant with the camera, crosshair, window and loaded data as they were. A hidden viewer
  // keeps the scene it last showed and draws nothing until it is shown again.
  const live: Kept | undefined =
    grid.state === "ready" && gridKey
      ? {
          key: gridKey,
          imageId: grid.imageId,
          scene: grid.scene,
          title: grid.name,
          notes: grid.notes,
          focus: shownFocus,
          at: 0,
        }
      : undefined;
  const [kept, setKept] = useState<Kept[]>([]);
  const latestLive = useRef(live);
  latestLive.current = live;
  useEffect(() => {
    const now = latestLive.current && { ...latestLive.current, at: Date.now() };
    if (!now) return;
    setKept((had) =>
      had.some((k) => k.key === now.key)
        ? had.map((k) => (k.key === now.key ? now : k))
        : [...(had.length < MAX_KEPT ? had : withoutOldest(had)), now],
    );
  }, [live?.key, live?.scene, live?.focus]);
  // Slots stay in the order their grids were first shown, so no viewer moves in the DOM. A redo
  // that replaces an image retires its viewer.
  const images = new Set(revision.volumes.map(gridKeyOf));
  const slots = kept.filter((k) => images.has(k.key)).map((k) => (k.key === live?.key ? live : k));
  if (live && !slots.includes(live)) slots.push(live);
  // One tree shape whether or not this task's grid is ready, so the kept viewers never remount.
  return (
    <>
      {grid.state !== "ready" && (
        <div
          className="grid h-full place-content-center p-6"
          role={grid.state === "failed" ? "alert" : "status"}
        >
          <EmptyState title={grid.state === "preparing" ? "Preparing the views" : "No views"}>
            {grid.message}
          </EmptyState>
        </div>
      )}
      {slots.map((k) => {
        const on = k === live;
        return (
          <div key={k.key} className="h-full" hidden={!on}>
            <GridViewer
              scene={k.scene}
              title={k.title}
              focus={k.focus}
              notes={k.notes}
              tool={on ? tool : null}
              marks={shown.get(k.key) ?? NO_MARKS}
              onMark={on ? (mark) => onMark(mark, k.imageId, k.key) : undefined}
              onReady={report(k.key)}
              ref={on ? viewer : undefined}
            >
              {on && (
                <>
                  <SegmentedControl
                    label="Marking tool"
                    options={TOOLS.map((t) => ({
                      ...t,
                      reason: full && t.value !== "navigate" ? FULL : undefined,
                    }))}
                    value={tool ?? "navigate"}
                    onValueChange={(v) => onTool(v === "navigate" ? null : v)}
                  />
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={labels}
                      onChange={(e) => setLabels(e.target.checked)}
                    />
                    Labels
                  </label>
                </>
              )}
            </GridViewer>
          </div>
        );
      })}
    </>
  );
}

/** A grid's viewer as last shown: what it keeps while hidden. */
type Kept = {
  key: string;
  imageId: string;
  scene: GridScene;
  title: string;
  notes: string[];
  focus: { at: Zyx } | undefined;
  /** When it was last shown, for eviction. */
  at: number;
};

/**
 * Viewers kept per page: the grid shown and the one before (mouse-oa has two). Each holds four
 * WebGL contexts and its decoded volume, and Chrome keeps at most 16 contexts per page.
 */
const MAX_KEPT = 2;
const NO_MARKS: ShownMark[] = [];

const withoutOldest = (kept: Kept[]) => {
  const oldest = kept.reduce((a, b) => (b.at < a.at ? b : a));
  return kept.filter((k) => k !== oldest);
};
