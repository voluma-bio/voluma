/**
 * The outputs review's viewer (Q24, mockup C): up to four equal panes on one analysis grid
 * through one crosshair. Each pane shows one view (3D, XY, XZ, YZ), picked from the chip in its
 * corner; picking a view another pane shows trades the two panes. A view is shown at most once.
 * Every view stays mounted and only moves between grid cells, so a swap, a layout change or full
 * screen keeps its camera, zoom and loaded data. The tool bar is docked under the panes: the
 * caller's tools on the left, the window and the 1/2/4 layout on the right.
 *
 * The layout (`QuadLayout`) is the caller's, so it holds when another output, on another grid,
 * is shown; the seams' positions are this grid's. Planes are coloured by the anatomy the grid's
 * catalog entry gives (`planes`), else left uncoloured.
 */
import type { Anatomy } from "@voluma/contracts/output-catalog";
import { cx, IconButton, Menu, MenuItem, Popover } from "@voluma/ui";
import {
  ChevronDown,
  Columns2,
  Grid2x2,
  Maximize2,
  Minimize2,
  Square,
  SunMedium,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { autoContrast, type Contrast } from "./compose";
import { Grid3D } from "./Grid3D";
import { NumberField } from "./number-field";
import { readLevel } from "./planes";
import { SlicePane } from "./SlicePane";
import type {
  Axis,
  GridMark,
  GridScene,
  MarkTool,
  PaneHandle,
  PaneStatus,
  ShownMark,
  Zyx,
} from "./scene";

/** What a pane can show. GP, the plane along the growth plate, comes with the plane tools. */
export type QuadView = "3d" | "xy" | "xz" | "yz" | "gp";

export type QuadLayout = {
  /** How many panes show: slots 0 to count − 1. Slot 0 is the one kept at 1. */
  count: 1 | 2 | 4;
  /** The view in each of the four slots, each view at most once. */
  views: readonly QuadView[];
  /** The view filling the centre, over the layout. */
  full: QuadView | null;
};

export const QUAD_START: QuadLayout = { count: 4, views: ["3d", "xy", "xz", "yz"], full: null };

/** Shows `view` in `slot`; a view another slot shows trades places with this slot's. */
export function showIn(layout: QuadLayout, slot: number, view: QuadView): QuadLayout {
  const views = [...layout.views];
  const was = views[slot]!;
  const from = views.indexOf(view);
  if (from === slot) return layout;
  if (from >= 0) views[from] = was;
  views[slot] = view;
  return { ...layout, views, full: layout.full === was ? view : layout.full };
}

/** Which anatomical plane each of the grid's planes is, from its catalog entry. */
export type GridPlanes = { XY: Anatomy; XZ: Anatomy; YZ: Anatomy };

const VIEWS: Record<
  QuadView,
  { label: string; axis: Axis | null; plane?: keyof GridPlanes; reason?: string; word?: string }
> = {
  "3d": { label: "3D", axis: null },
  xy: { label: "XY", axis: 0, plane: "XY" },
  xz: { label: "XZ", axis: 1, plane: "XZ" },
  yz: { label: "YZ", axis: 2, plane: "YZ" },
  gp: {
    label: "GP",
    axis: null,
    word: "along the growth plate",
    reason: "Comes with the plane tools",
  },
};
/** The views that mount; GP waits for the plane tools. */
const MOUNTED = ["3d", "xy", "xz", "yz"] as const;

/** Literal class names, so Tailwind sees them. */
const ANATOMY: Record<Anatomy, { token: string; ring: string; chip: string; swatch: string }> = {
  coronal: {
    token: "--axis-x",
    ring: "inset-ring-axis-x",
    chip: "bg-axis-x text-viewer-well",
    swatch: "bg-axis-x",
  },
  sagittal: {
    token: "--axis-y",
    ring: "inset-ring-axis-y",
    chip: "bg-axis-y text-viewer-well",
    swatch: "bg-axis-y",
  },
  axial: {
    token: "--axis-z",
    ring: "inset-ring-axis-z",
    chip: "bg-axis-z text-viewer-well",
    swatch: "bg-axis-z",
  },
};
const NEUTRAL = {
  ring: "",
  chip: "bg-viewer-chip text-viewer-chip-fg",
  swatch: "bg-viewer-chip-fg",
};

/** The gap between panes, in px: the seams. */
const GAP = 4;
const clampSplit = (f: number) => Math.min(0.8, Math.max(0.2, f));

export function QuadViewer({
  scene,
  planes,
  layout,
  onLayout,
  focus,
  notes = [],
  children,
  tool = null,
  marks,
  onMark,
  onReady,
}: {
  /** Remount (`key`) for another grid; on the same grid, new overlays redraw in place. */
  scene: GridScene;
  planes?: GridPlanes;
  layout: QuadLayout;
  onLayout(layout: QuadLayout): void;
  /** A voxel to centre the crosshair on: each new object moves it there once. */
  focus?: { at: Zyx };
  /** What the viewer should say it doesn't show. */
  notes?: string[];
  /** The tools, on the left of the docked bar. */
  children?: ReactNode;
  tool?: MarkTool | null;
  marks: readonly ShownMark[];
  onMark?(mark: GridMark): void;
  /** Whether every shown pane has a picture. */
  onReady?(ready: boolean): void;
}) {
  const [point, setPoint] = useState<Zyx>(
    () => focus?.at ?? (scene.shapeZyx.map((n) => Math.floor(n / 2)) as unknown as Zyx),
  );
  useEffect(() => {
    if (focus) setPoint(focus.at);
  }, [focus]);
  const [contrast, setContrast] = useState<Contrast | null>(null);
  const [contrastError, setContrastError] = useState<string>();
  const [status, setStatus] = useState<Partial<Record<QuadView, PaneStatus>>>({});
  const [split, setSplit] = useState({ col: 0.5, row: 0.5 });
  const handles = useRef(
    Object.fromEntries(MOUNTED.map((v) => [v, { current: null as PaneHandle | null }])),
  ).current;
  const latestMark = useRef(onMark);
  latestMark.current = onMark;
  const [mark] = useState(() => (m: GridMark) => latestMark.current?.(m));
  const area = useRef<HTMLDivElement>(null);

  // The contrast spans the coarsest level's values, so the first picture already uses it.
  useEffect(() => {
    const abort = new AbortController();
    const coarsest = scene.image.levels.at(-1)!;
    readLevel(scene.image.base, coarsest.path, abort.signal)
      .then((level) => setContrast((had) => had ?? autoContrast(level.data)))
      .catch((cause) => {
        if (!abort.signal.aborted) setContrastError((cause as Error).message);
      });
    return () => abort.abort();
  }, [scene.image.base]);

  const shown: readonly QuadView[] = layout.full
    ? [layout.full]
    : layout.views.slice(0, layout.count);
  const ready = shown.every(
    (v) => !!contrast && status[v] !== undefined && status[v] !== "loading",
  );
  const latestReady = useRef(onReady);
  latestReady.current = onReady;
  useEffect(() => latestReady.current?.(ready), [ready]);

  const anatomyOf = (view: QuadView) => {
    const plane = VIEWS[view].plane;
    return plane && planes ? planes[plane] : undefined;
  };
  const planesKey = planes && `${planes.XY}|${planes.XZ}|${planes.YZ}`;
  // Stable per grid: the slices redraw their crosshair lines when it changes.
  const planeToken = useMemo(
    () => (axis: Axis) => {
      const plane = (["XY", "XZ", "YZ"] as const)[axis];
      return planes ? ANATOMY[planes[plane]].token : undefined;
    },
    [planesKey],
  );
  const styleOf = (view: QuadView) => {
    const a = anatomyOf(view);
    return a ? ANATOMY[a] : NEUTRAL;
  };

  const cols = layout.full || layout.count === 1 ? "1fr" : `${split.col}fr ${1 - split.col}fr`;
  const rows = layout.full || layout.count < 4 ? "1fr" : `${split.row}fr ${1 - split.row}fr`;
  const cellOf = (view: QuadView) => {
    if (layout.full) return "1 / 1";
    const slot = layout.views.indexOf(view);
    return `${slot < 2 ? 1 : 2} / ${(slot % 2) + 1}`;
  };
  const setFull = (view: QuadView | null) => onLayout({ ...layout, full: view });

  const seam = (dir: "col" | "row") => {
    const at = split[dir];
    const name = dir === "col" ? "Resize the panes' columns" : "Resize the panes' rows";
    return (
      // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable splitter; <hr> can't take focus or pointer drags
      <div
        role="separator"
        aria-label={name}
        aria-orientation={dir === "col" ? "vertical" : "horizontal"}
        aria-valuenow={Math.round(at * 100)}
        aria-valuemin={20}
        aria-valuemax={80}
        tabIndex={0}
        className={cx(
          "absolute z-30 outline-none hover:bg-select focus-visible:bg-select",
          dir === "col" ? "inset-y-0 w-2 cursor-col-resize" : "inset-x-0 h-2 cursor-row-resize",
        )}
        style={
          dir === "col"
            ? { left: `calc(${at} * (100% - ${GAP}px) - ${(8 - GAP) / 2}px)` }
            : { top: `calc(${at} * (100% - ${GAP}px) - ${(8 - GAP) / 2}px)` }
        }
        onKeyDown={(event) => {
          const by = { ArrowLeft: -0.02, ArrowUp: -0.02, ArrowRight: 0.02, ArrowDown: 0.02 }[
            event.key
          ];
          if (by === undefined) return;
          event.preventDefault();
          setSplit((s) => ({ ...s, [dir]: clampSplit(s[dir] + by) }));
        }}
        onPointerDown={(event) => {
          const el = event.currentTarget;
          const rect = area.current!.getBoundingClientRect();
          el.setPointerCapture(event.pointerId);
          const move = (e: PointerEvent) => {
            const f =
              dir === "col"
                ? (e.clientX - rect.left - GAP / 2) / (rect.width - GAP)
                : (e.clientY - rect.top - GAP / 2) / (rect.height - GAP);
            setSplit((s) => ({ ...s, [dir]: clampSplit(f) }));
          };
          const up = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
          };
          el.addEventListener("pointermove", move);
          el.addEventListener("pointerup", up);
          el.addEventListener("pointercancel", up);
        }}
      />
    );
  };

  const onStatus = useCallback(
    (view: QuadView) => (next: PaneStatus) =>
      setStatus((had) => (had[view] === next ? had : { ...had, [view]: next })),
    [],
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Views">
      {(notes.length > 0 || contrastError) && (
        <div className="grid gap-1 px-3 py-2 text-xs text-muted-foreground">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
          {contrastError && (
            <p className="text-destructive" role="alert">
              Couldn't load the image: {contrastError}
            </p>
          )}
        </div>
      )}
      <div
        ref={area}
        className="relative grid min-h-0 flex-1"
        style={{ gridTemplateColumns: cols, gridTemplateRows: rows, gap: GAP }}
      >
        {MOUNTED.map((view) => {
          const { label, axis } = VIEWS[view];
          const visible = shown.includes(view);
          const isFull = layout.full === view;
          const slot = layout.views.indexOf(view);
          const look = styleOf(view);
          return (
            <section
              key={view}
              aria-label={label}
              hidden={!visible}
              className="relative flex min-h-0 min-w-0 flex-col overflow-hidden [&[hidden]]:hidden"
              style={{ gridArea: cellOf(view) }}
              onDoubleClick={(event) => {
                // With a marking tool a click marks; only Navigate fills the centre.
                if (tool || (event.target as HTMLElement).closest("button, [role=menu]")) return;
                setFull(isFull ? null : view);
              }}
            >
              {axis === null ? (
                <Grid3D
                  scene={scene}
                  contrast={contrast}
                  onPoint={setPoint}
                  handle={handles[view]!}
                  onStatus={onStatus(view)}
                  tool={tool}
                  marks={marks}
                  onMark={mark}
                />
              ) : (
                <SlicePane
                  axis={axis}
                  scene={scene}
                  point={point}
                  onPoint={setPoint}
                  contrast={contrast}
                  handle={handles[view]!}
                  onStatus={onStatus(view)}
                  tool={tool}
                  marks={marks}
                  onMark={mark}
                  planeToken={planeToken}
                />
              )}
              <div
                aria-hidden
                className={cx("pointer-events-none absolute inset-0 z-10 inset-ring-1", look.ring)}
              />
              <div className="absolute right-2 bottom-2 z-20 flex items-center gap-1">
                <IconButton
                  size="sm"
                  label={isFull ? "Back to the panes" : `Fill the views with ${label}`}
                  shortcut={isFull ? "Escape" : undefined}
                  className="bg-viewer-chip text-viewer-chip-fg hover:bg-viewer-well hover:text-viewer-chip-fg"
                  onClick={() => setFull(isFull ? null : view)}
                >
                  {isFull ? <Minimize2 /> : <Maximize2 />}
                </IconButton>
                <ViewChip
                  view={view}
                  look={look.chip}
                  layout={layout}
                  styleOf={styleOf}
                  onPick={(next) => onLayout(showIn(layout, slot, next))}
                />
              </div>
            </section>
          );
        })}
        {!layout.full && layout.count > 1 && seam("col")}
        {!layout.full && layout.count === 4 && seam("row")}
      </div>
      <div
        role="toolbar"
        aria-label="Tools"
        className="flex h-10 shrink-0 items-center gap-2 border-t border-border bg-card px-2"
      >
        {children}
        <span className="flex-1" />
        {contrast && (
          <Popover
            label="Window"
            align="end"
            side="top"
            className="w-auto"
            trigger={
              <IconButton label="Window" size="sm">
                <SunMedium />
              </IconButton>
            }
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <NumberField
                label="Window low"
                value={contrast.low}
                onCommit={(low) => setContrast({ ...contrast, low })}
              />
              <NumberField
                label="high"
                value={contrast.high}
                onCommit={(high) => setContrast({ ...contrast, high })}
              />
            </div>
          </Popover>
        )}
        <fieldset className="flex">
          <legend className="sr-only">Panes</legend>
          {(
            [
              [1, "One pane", <Square key="1" />],
              [2, "Two panes", <Columns2 key="2" />],
              [4, "Four panes", <Grid2x2 key="4" />],
            ] as const
          ).map(([count, label, icon]) => (
            <IconButton
              key={count}
              size="sm"
              label={label}
              aria-pressed={layout.count === count && !layout.full}
              className="aria-pressed:bg-secondary aria-pressed:text-foreground"
              onClick={() => onLayout({ ...layout, count, full: null })}
            >
              {icon}
            </IconButton>
          ))}
        </fieldset>
      </div>
    </section>
  );
}

/** A pane's chip: what it shows, and the choice of another view. */
function ViewChip({
  view,
  look,
  layout,
  styleOf,
  onPick,
}: {
  view: QuadView;
  look: string;
  layout: QuadLayout;
  styleOf(view: QuadView): { swatch: string };
  onPick(view: QuadView): void;
}) {
  const shownElsewhere = (v: QuadView) =>
    v !== view && layout.views.slice(0, layout.count).includes(v);
  return (
    <Menu
      align="end"
      className="w-64"
      trigger={
        <button
          type="button"
          aria-label={`${VIEWS[view].label}: show another view in this pane`}
          className={cx(
            "flex h-6 cursor-pointer items-center gap-0.5 rounded-sm pr-1 pl-1.5 font-mono text-xs font-medium",
            look,
          )}
        >
          {VIEWS[view].label}
          <ChevronDown aria-hidden className="size-3" />
        </button>
      }
    >
      {(Object.keys(VIEWS) as QuadView[]).map((v) => (
        <MenuItem
          key={v}
          disabled={!!VIEWS[v].reason}
          icon={<span className={cx("size-3 rounded-[2px]", styleOf(v).swatch)} />}
          onSelect={() => onPick(v)}
        >
          <span className="flex items-baseline justify-between gap-3">
            <span>
              <span className="font-mono">{VIEWS[v].label}</span>
              {VIEWS[v].word && (
                <span className="ml-2 text-xs text-muted-foreground">{VIEWS[v].word}</span>
              )}
            </span>
            <span className="text-xs text-fg-subtle">
              {v === view
                ? "Shown"
                : VIEWS[v].reason
                  ? VIEWS[v].reason
                  : shownElsewhere(v)
                    ? "Swaps"
                    : ""}
            </span>
          </span>
        </MenuItem>
      ))}
    </Menu>
  );
}
