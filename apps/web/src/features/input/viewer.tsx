/**
 * The input review's main area: the output in view on its own analysis grid in the four-pane
 * viewer (`QuadViewer`), with the blocks it names drawn on it, from the run's converted assets.
 * Loaded lazily, with three.js. Each grid gets its own viewer, kept mounted and hidden while
 * another grid is shown. The marking tools sit on the viewer's bar when the page takes marks
 * (`onTool`); your marks on this grid's image are drawn, and a new one is named by that image's
 * id. The page learns which grid is shown (`onShown`), since marks and the picture belong to it.
 */
import { reviewAssetUrl } from "@voluma/api-client";
import type { Focus, ReviewAssets } from "@voluma/contracts/review";
import { EmptyState, ErrorState, SegmentedControl } from "@voluma/ui";
import {
  type Blocks,
  type GridMark,
  type GridPlanes,
  type GridScene,
  labelsMiddle,
  type MarkEdit,
  type MarkPlane,
  type MarkTool,
  type PlaneFit,
  planeTargets,
  type QuadLayout,
  type QuadState,
  QuadViewer,
  type QuadViewerHandle,
  reviewGrid,
  type ShownMark,
  tokenColor,
  type Zyx,
} from "@voluma/viewer/grid";
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { gridKeyOf, type ShownGrid, TOOLS, type YourMark } from "./marking";

export function SceneViewer({
  runId,
  revision,
  subject,
  assets,
  focus,
  tool,
  onTool,
  marks,
  selected,
  jump,
  onJumped,
  onMark,
  onShown,
  quad,
}: {
  runId: string;
  revision: Blocks;
  /** The output in view: its id and the block ids it shows. */
  subject: { id: string; shown: readonly string[] };
  assets: Record<string, ReviewAssets>;
  /** The selected item's place: each new object moves the crosshair there once. */
  focus?: Focus;
  tool: MarkTool | null;
  /** Absent: the page takes no marks, and the marking tools are not shown. */
  onTool?: (tool: MarkTool | null) => void;
  marks: readonly YourMark[];
  selected: string | undefined;
  /** A mark picked: it moves the crosshair once its grid is shown, then `onJumped`. */
  jump?: { at: Zyx; gridKey: string; output: string };
  onJumped: () => void;
  /** A new mark, on the image volume `volumeId`; returns its id. */
  onMark: (
    mark: GridMark,
    volumeId: string,
    gridKey: string,
    plane?: MarkPlane | null,
  ) => string | undefined;
  /** The mounted output and grid; undefined while no viewer is shown. */
  onShown: (shown: ShownGrid | undefined) => void;
  /** The four panes' layout, which holds across grids, and each grid's planes by the image's id. */
  quad: {
    layout: QuadLayout;
    onLayout(layout: QuadLayout): void;
    planesOf(imageId: string): GridPlanes | undefined;
    /** The planes the catalog fits through surfaces, for Align and GP. */
    fits: readonly PlaneFit[];
    /** A point's note. */
    onNote(id: string, note: string): void;
    /** Saves the view on the grid of image volume `grid`; absent, no Save view. */
    onSave?(state: QuadState, grid: string): void;
    /** A saved view to show on its grid: each new object is applied once. */
    restore?: { grid: string; state: QuadState };
    /**
     * With Navigate, an end dragged in a slice: of your mark, or of a published ruler (a new mark
     * of yours on the grid's image `volumeId`), with the pane's frame.
     */
    onEdit?(edit: MarkEdit, volumeId: string, gridKey: string, plane: MarkPlane): void;
    /** A mark of yours clicked at an end. */
    onPick?(id: string): void;
    /** The shown grid's view and picture, for a message. */
    ref?: Ref<SceneHandle>;
  };
}) {
  const [labels, setLabels] = useState(false);
  const grid = useMemo(
    () =>
      reviewGrid({
        revision,
        shown: subject.shown,
        assets,
        labels,
        focus,
        // The zarr reader resolves level paths against this, so it is absolute.
        assetBase: (sha256) =>
          new URL(reviewAssetUrl(runId, sha256, "x").slice(0, -1), location.href).href,
        token: tokenColor,
      }),
    [runId, revision, subject.shown, assets, labels, focus],
  );
  // A focused label has no extent in the run's data: find its middle on the grid. Keyed by
  // what it reads, since `grid` is rebuilt whenever Labels is toggled.
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
  // Labels is toggled.
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
  const [aim, setAim] = useState({ gridKey, target });
  useEffect(() => setAim({ gridKey, target }), [gridKey, target]);
  useEffect(() => {
    if (!jump) return;
    if (jump.gridKey === gridKey) {
      setAim({ gridKey, target: { at: jump.at } });
      onJumped();
    } else if (jump.output === subject.id) onJumped();
  }, [jump, gridKey, subject.id, onJumped]);
  // A new grid mounts before effects run; never initialize it with the previous grid's voxel.
  const shownFocus = aim.gridKey === gridKey ? aim.target : target;
  const shown = useMemo(() => {
    const byGrid = new Map<string, ShownMark[]>();
    for (const m of marks) {
      const on = byGrid.get(m.gridKey) ?? [];
      on.push({
        id: m.id,
        tag: m.tag,
        mark: m.mark,
        by: "you",
        selected: m.id === selected,
        movable: !m.theirs,
      });
      byGrid.set(m.gridKey, on);
    }
    return byGrid;
  }, [marks, selected]);
  // What the shown grid's planes can be aligned to: the catalog's fitted planes, the other grids.
  const { fits } = quad;
  const targets = useMemo(
    () =>
      imageId
        ? planeTargets({
            revision,
            imageId,
            assets,
            fits,
            assetBase: (sha256) => reviewAssetUrl(runId, sha256, "x").slice(0, -1),
          })
        : undefined,
    [revision, imageId, assets, fits, runId],
  );

  // Each grid shown keeps its viewer, hidden while another grid is shown, so going back is
  // instant with the camera, crosshair, window and loaded data as they were. A hidden viewer
  // keeps the scene it last showed and draws nothing until it is shown again.
  const live: View | undefined =
    grid.state === "ready" && gridKey
      ? {
          key: gridKey,
          imageId: grid.imageId,
          name: grid.name,
          scene: grid.scene,
          notes: grid.notes,
          focus: shownFocus,
        }
      : undefined;
  const [kept, setKept] = useState<Kept[]>([]);
  // What mounts is what `kept` becomes once this render commits, so a new grid never mounts a
  // viewer past the cap and a replaced image's viewer leaves at once.
  const slots = keep(kept, live, revision);
  const latest = useRef({ live, revision });
  latest.current = { live, revision };
  useEffect(() => {
    setKept((had) => keep(had, latest.current.live, latest.current.revision));
  }, [live?.key, live?.scene, live?.focus, revision]);
  // A viewer reports readiness while hidden; an evicted one takes its readiness with it.
  const report = (key: string) => (ready: boolean) =>
    setKept((had) =>
      had.some((k) => k.key === key && k.ready !== ready)
        ? had.map((k) => (k.key === key ? { ...k, ready } : k))
        : had,
    );
  const shownReady = !!live && !!slots.find((k) => k.key === live.key)?.ready;
  const shownQuad = useRef<QuadViewerHandle>(null);
  useImperativeHandle(
    quad.ref,
    () => ({
      view: () => {
        const state = shownQuad.current?.state();
        return state && live ? { state, grid: live.imageId } : undefined;
      },
      snapshot: async (maxBytes) => (await shownQuad.current?.snapshot(maxBytes)) ?? null,
    }),
    [live?.imageId],
  );
  useEffect(
    () => onShown(gridKey ? { key: gridKey, output: subject.id, ready: shownReady } : undefined),
    [gridKey, subject.id, shownReady, onShown],
  );
  useEffect(() => () => onShown(undefined), [onShown]);
  // The marking tools and the Labels toggle, on the shown viewer's bar.
  const bar = (on: boolean) =>
    on && (
      <>
        {onTool && (
          <SegmentedControl
            label="Marking tool"
            options={TOOLS.map((t) => ({
              value: t.value,
              label: t.label,
              shortcut: t.keys[0],
              icon: t.icon,
            }))}
            value={tool ?? "navigate"}
            onValueChange={(v) => onTool(v === "navigate" ? null : v)}
          />
        )}
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />
          Labels
        </label>
      </>
    );
  // One tree shape whether or not this subject's grid is ready, so the kept viewers never remount.
  return (
    <>
      {grid.state !== "ready" && (
        <div className="grid h-full place-content-center p-6">
          {grid.state === "failed" ? (
            <ErrorState title={grid.message} />
          ) : (
            <div role="status">
              <EmptyState title={grid.state === "preparing" ? "Preparing the views" : "No views"}>
                {grid.message}
              </EmptyState>
            </div>
          )}
        </div>
      )}
      {slots.map((k) => {
        const on = k.key === live?.key;
        return (
          <div key={k.key} className="h-full" hidden={!on}>
            <QuadViewer
              scene={k.scene}
              gridName={k.name}
              planes={quad.planesOf(k.imageId)}
              layout={quad.layout}
              onLayout={quad.onLayout}
              focus={k.focus}
              notes={k.notes}
              tool={on ? tool : null}
              marks={shown.get(k.key) ?? NO_MARKS}
              onMark={on ? (mark, plane) => onMark(mark, k.imageId, k.key, plane) : undefined}
              onNote={quad.onNote}
              onReady={report(k.key)}
              targets={k.imageId === live?.imageId ? targets : undefined}
              onSave={on && quad.onSave ? (state) => quad.onSave?.(state, k.imageId) : undefined}
              restore={quad.restore?.grid === k.imageId ? quad.restore.state : undefined}
              onEdit={
                on && quad.onEdit
                  ? (edit, plane) => quad.onEdit?.(edit, k.imageId, k.key, plane)
                  : undefined
              }
              onPick={quad.onPick}
              ref={on ? shownQuad : undefined}
            >
              {bar(on)}
            </QuadViewer>
          </div>
        );
      })}
    </>
  );
}

/** The shown grid, as a message takes it: its view (`QuadState` on image `grid`) and a picture. */
export type SceneHandle = {
  view(): { state: QuadState; grid: string } | undefined;
  /** The shown panes as one PNG of at most `maxBytes`; null when they have no picture or none fits. */
  snapshot(maxBytes: number): Promise<Blob | null>;
};

/** What a grid's viewer is given; a hidden one keeps what it was last given. */
type View = {
  key: string;
  imageId: string;
  name: string;
  scene: GridScene;
  notes: string[];
  focus: { at: Zyx } | undefined;
};
type Kept = View & { ready: boolean };

/**
 * Viewers kept per page: the grid shown and the one before (mouse-oa has two). Each holds four
 * WebGL contexts and its decoded volume, and Chrome keeps at most 16 contexts per page.
 */
const MAX_KEPT = 2;
const NO_MARKS: ShownMark[] = [];

/**
 * The viewers to keep, least recently shown first: those whose image is still in the revision (a
 * redo that replaces an image retires its viewer), with the shown grid last and up to date.
 * Reordering moves a viewer in the DOM; its canvases keep their WebGL contexts.
 */
const keep = (had: Kept[], live: View | undefined, revision: Blocks): Kept[] => {
  const images = new Set(revision.volumes.map(gridKeyOf));
  const others = had.filter((k) => k.key !== live?.key && images.has(k.key));
  if (!live) return others.length === had.length ? had : others;
  const ready = had.find((k) => k.key === live.key)?.ready ?? false;
  return [...others, { ...live, ready }].slice(-MAX_KEPT);
};
