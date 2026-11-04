/**
 * The outputs review's viewer (Q24, mockup C): up to four equal panes on one analysis grid
 * through one crosshair. Each pane shows one view (3D, XY, XZ, YZ, or GP: the plane fitted to an
 * anatomical surface), picked from the chip in its corner; picking a view another pane shows
 * trades the two panes. A view is shown at most once. Every view stays mounted and only moves
 * between grid cells, so a swap, a layout change or full screen keeps its camera, zoom and loaded
 * data. The tool bar is docked under the panes: the caller's tools on the left; how far the
 * planes are turned (or, on the grid's axes, the grid's name), Align, Turn, Reset, the window,
 * the 1/2/4 layout and Save view on the right; tools, Planes and Contrast are icons named by their tooltips.
 *
 * The three planes turn together (`frame.ts`): tilted by hand from the dots at their crosshair
 * lines' ends, spun by turning one pane's image in place (Alt-drag or `,` `.` in it, or Turn's
 * buttons), or all at once with Align (a fitted plane, another grid's axes); Reset puts them back
 * on the grid's axes. The orientation is this grid's and holds while other outputs on it are shown.
 *
 * The layout (`QuadLayout`) is the caller's, so it holds when another output, on another grid,
 * is shown; the seams' positions are this grid's. A layout naming GP fits the plane whenever GP
 * is shown; on a grid with nothing to fit (or a failed fit) its slot shows the view GP replaced. Planes are coloured by the anatomy the grid's
 * catalog entry gives (`planes`), a tilted one by the grid plane nearest it, else left uncoloured.
 */
import { type Anatomy, unitAsWritten } from "@voluma/contracts/output-catalog";
import { Button, cx, IconButton, Menu, MenuItem, Popover } from "@voluma/ui";
import {
  Axis3d,
  Bookmark,
  ChevronDown,
  Columns2,
  Grid2x2,
  Maximize2,
  Minimize2,
  Rotate3d,
  RotateCcw,
  RotateCw,
  Square,
  SunMedium,
} from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { autoContrast, type Contrast } from "./compose";
import {
  alongAxes,
  alongPlane,
  type Basis,
  basisAlong,
  GRID,
  nearestAxis,
  type Orientation,
  orientationWords,
  spin,
  tilt,
  type Vec3,
} from "./frame";
import { Grid3D } from "./Grid3D";
import { NumberField } from "./number-field";
import { CHIP, PANE } from "./pane-style";
import { holdLevel } from "./planes";
import { axisToken, SlicePane } from "./SlicePane";
import {
  type Axis,
  type GridMark,
  type GridScene,
  type MarkEdit,
  type MarkTool,
  type PaneHandle,
  type PaneStatus,
  type PaneView,
  pngWithin,
  type ShownMark,
  SNAPSHOT_WIDTH,
  type VoxelBox,
  type Zyx,
} from "./scene";
import { tokenColor } from "./token-color";

/** What a pane can show: 3D, the three planes, or the plane fitted to an anatomical surface (GP). */
export type QuadView = "3d" | "xy" | "xz" | "yz" | "gp";

/** The pane a mark was made in: its view and its basis in the grid's mm, (z, y, x). */
export type MarkPlane = Basis & { view: Exclude<QuadView, "3d"> };

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
function showIn(layout: QuadLayout, slot: number, view: QuadView): QuadLayout {
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

/**
 * Something the planes can be aligned to: a plane fitted through anatomical surfaces, which is
 * also a view of its own (`code`, "GP"), or another grid's or frame's axes.
 */
export type PlaneTarget = {
  id: string;
  /** In words after "Along": "the growth plate", "the scan". */
  name: string;
  /** A fitted plane's view, named on its chip; none for a grid's axes. */
  code?: string;
  /** Said beside the name: what made it ("intake"). */
  tag?: string;
  /** Why it can't be had yet; then there is no `load`. */
  reason?: string;
  /** Its frame in this grid's mm, (z, y, x): a plane's normal, or a grid's z, y and x axes. */
  load?(): Promise<{ normal: Vec3 } | { axes: readonly [Vec3, Vec3, Vec3] }>;
};

/** Everything a saved view holds, as the viewer keeps it (`saved-view.ts` stores it). */
export type QuadState = {
  orientation: Orientation;
  /** The target the planes were last aligned to, unless turned by hand since. */
  aligned: { id: string; name: string } | null;
  /** The crosshair, in source voxels. */
  point: Zyx;
  contrast: Contrast | null;
  layout: QuadLayout;
  /** Each view's own zoom and centre, or 3D camera. */
  views: Partial<Record<QuadView, PaneView>>;
};

/** The view as it is now, and a picture of it, for a message that carries both. */
export type QuadViewerHandle = {
  /** What Save view would save now. */
  state(): QuadState;
  /**
   * The shown panes as one PNG laid out as on screen with their names, at most `maxBytes`; null
   * while a shown pane has no picture, or when no copy fits.
   */
  snapshot(maxBytes: number): Promise<Blob | null>;
};

const FRAME = { xy: 0, xz: 1, yz: 2 } as const satisfies Partial<Record<QuadView, Axis>>;
const PLANE_OF = ["XY", "XZ", "YZ"] as const;
const LABEL: Record<Exclude<QuadView, "gp">, string> = {
  "3d": "3D",
  xy: "XY",
  xz: "XZ",
  yz: "YZ",
};
const VIEW_ORDER: readonly QuadView[] = ["3d", "xy", "xz", "yz", "gp"];

/** Literal class names, so Tailwind sees them. */
const ANATOMY: Record<Anatomy, { token: string; ring: string; chip: string; swatch: string }> = {
  coronal: {
    token: "--plane-coronal",
    ring: "inset-ring-plane-coronal",
    chip: "bg-plane-coronal text-viewer-well",
    swatch: "bg-plane-coronal",
  },
  sagittal: {
    token: "--plane-sagittal",
    ring: "inset-ring-plane-sagittal",
    chip: "bg-plane-sagittal text-viewer-well",
    swatch: "bg-plane-sagittal",
  },
  axial: {
    token: "--plane-axial",
    ring: "inset-ring-plane-axial",
    chip: "bg-plane-axial text-viewer-well",
    swatch: "bg-plane-axial",
  },
};
const NEUTRAL = {
  ring: "",
  chip: "bg-viewer-chip text-viewer-chip-fg",
  swatch: "bg-viewer-chip-fg",
};

/** What Turn's buttons turn a plane's image by, in degrees clockwise. */
const TURNS = [-5, -1, 1, 5] as const;
const Key = ({ children }: { children: ReactNode }) => (
  <kbd className="font-mono text-foreground">{children}</kbd>
);
const capital = (word: string) => word[0]!.toUpperCase() + word.slice(1);
const lower = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/** The gap between panes, in px: the seams. */
const GAP = 4;
const clampSplit = (f: number) => Math.min(0.8, Math.max(0.2, f));

let webgl: boolean | undefined;
/** Whether panes can draw: three.js needs WebGL 2, and without it every pane throws. */
function hasWebGL() {
  if (webgl === undefined) {
    const gl = document.createElement("canvas").getContext("webgl2");
    webgl = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return webgl;
}

export function QuadViewer({
  scene,
  gridName,
  planes,
  layout: given,
  onLayout,
  focus,
  notes = [],
  heading,
  children,
  tool = null,
  marks,
  onMark,
  onEdit,
  onPick,
  onReady,
  targets = [],
  onSave,
  restore,
  ref,
}: {
  /** Remount (`key`) for another grid; on the same grid, new overlays redraw in place. */
  scene: GridScene;
  /**
   * The grid's name ("Tibia long-axis grid"): said in the tool bar while the planes lie on its axes,
   * and Align's first entry, which puts them back there (the grid the outputs on it were measured on).
   */
  gridName?: string;
  planes?: GridPlanes;
  layout: QuadLayout;
  onLayout(layout: QuadLayout): void;
  /**
   * A voxel to centre the crosshair on and, given a box, a region every pane frames: each new
   * object moves them there once.
   */
  focus?: { at: Zyx; box?: VoxelBox };
  /** What the viewer should say it doesn't show. */
  notes?: string[];
  /** What the views show, laid over the top-left pane's corner (clear of its own buttons). */
  heading?: ReactNode;
  /** The tools, on the left of the docked bar. */
  children?: ReactNode;
  tool?: MarkTool | null;
  marks: readonly ShownMark[];
  /** A new mark, with the frame of the pane it was made in (null in 3D). */
  onMark?(mark: GridMark, plane: MarkPlane | null): void;
  /** An end of a movable mark or a published ruler dragged in a slice, with that pane's frame. */
  onEdit?(edit: MarkEdit, plane: MarkPlane): void;
  /** A mark selected in a pane, or undefined to clear the selection. */
  onPick?(id?: string): void;
  /** Whether every shown pane has a picture. */
  onReady?(ready: boolean): void;
  /** What Align offers; a target with a `code` is also the GP view. */
  targets?: readonly PlaneTarget[];
  /** Saves the view as it is now; absent, no Save view. */
  onSave?(state: QuadState): void;
  /** A saved view to show: each new object is applied once. */
  restore?: QuadState;
  ref?: Ref<QuadViewerHandle>;
}) {
  const [point, setPoint] = useState<Zyx>(
    () => focus?.at ?? (scene.shapeZyx.map((n) => Math.floor(n / 2)) as unknown as Zyx),
  );
  const [contrast, setContrast] = useState<Contrast | null>(null);
  const [contrastError, setContrastError] = useState<string>();
  const [status, setStatus] = useState<Partial<Record<QuadView, PaneStatus>>>({});
  const [split, setSplit] = useState({ col: 0.5, row: 0.5 });
  const [orientation, setOrientation] = useState<Orientation>(GRID);
  // Whether 3D outlines where the three slices cut the grid (the Planes popover's first item).
  const [planesIn3d, setPlanesIn3d] = useState(true);
  const [aligned, setAligned] = useState<{ id: string; name: string } | null>(null);
  const [aligning, setAligning] = useState<string>();
  const [alignError, setAlignError] = useState<string>();
  // The fitted plane the GP view shows: loaded whenever GP is shown or Align fits it.
  const plateTarget = targets.find((t) => t.code);
  const [fitted, setFitted] = useState<{ id: string; normal?: Vec3; error?: string }>();
  const plate = fitted?.id === plateTarget?.id ? fitted?.normal : undefined;
  const handles = useRef(
    Object.fromEntries(VIEW_ORDER.map((v) => [v, { current: null as PaneHandle | null }])),
  ).current;
  useEffect(() => {
    if (!focus) return;
    setPoint(focus.at);
    const { box } = focus;
    if (box) for (const v of VIEW_ORDER) handles[v]?.current?.frame(box);
  }, [focus]);
  const latestMark = useRef({ onMark, onEdit, onPick, orientation, plate });
  latestMark.current = { onMark, onEdit, onPick, orientation, plate };
  const area = useRef<HTMLDivElement>(null);

  // The contrast spans the coarsest level's values, so the first picture already uses it.
  useEffect(() => {
    let gone = false;
    const coarsest = holdLevel(scene.image.base, scene.image.levels.at(-1)!.path);
    coarsest.read
      .then((level) => {
        if (!gone) setContrast((had) => had ?? autoContrast(level.data));
      })
      .catch((cause) => {
        if (!gone) setContrastError((cause as Error).message);
      });
    return () => {
      gone = true;
      coarsest.release();
    };
  }, [scene.image.base]);

  /** Loads a target's frame; a fitted plane is also kept for the GP view. */
  const loadTarget = async (target: PlaneTarget) => {
    if (!target.load) return null;
    setAligning(target.id);
    setAlignError(undefined);
    try {
      const frame = await target.load();
      if (target.code && "normal" in frame) setFitted({ id: target.id, normal: frame.normal });
      return frame;
    } catch (cause) {
      setAlignError(`Couldn't align to ${target.name}: ${(cause as Error).message}`);
      return null;
    } finally {
      setAligning(undefined);
    }
  };
  const align = async (target: PlaneTarget) => {
    const frame = await loadTarget(target);
    if (!frame) return;
    setOrientation("normal" in frame ? alongPlane(frame.normal) : alongAxes(frame.axes));
    setAligned({ id: target.id, name: target.name });
  };
  const reset = () => {
    setOrientation(GRID);
    setAligned(null);
  };
  const lie = orientationWords(orientation, aligned?.name);

  // The layout holds across grids and saved views, so it can name GP on a grid that has no fitted
  // plane (or whose fit failed): there the slot shows the view GP replaced, the one it leaves out.
  // Every write goes back as `given`, so the substitution never reaches the caller's layout.
  const gpFailed = fitted?.id === plateTarget?.id && !!fitted?.error;
  const spare =
    plateTarget?.load && !gpFailed
      ? undefined
      : (VIEW_ORDER.find((v) => v !== "gp" && !given.views.includes(v)) ?? "3d");
  const layout = useMemo(() => {
    if (!spare) return given;
    const swap = (v: QuadView) => (v === "gp" ? spare : v);
    return { ...given, views: given.views.map(swap), full: given.full && swap(given.full) };
  }, [given, spare]);
  /** The caller's name for a view shown here: the spare is GP's slot. */
  const givenView = (v: QuadView) => (v === spare && given.views.includes("gp") ? "gp" : v);
  const shown: readonly QuadView[] = layout.full
    ? [layout.full]
    : layout.views.slice(0, layout.count);
  const showsGp = shown.includes("gp");
  const wantsPlate = showsGp && !plate;
  useEffect(() => {
    const target = plateTarget;
    if (!wantsPlate || !target?.load) return;
    let gone = false;
    target
      .load()
      .then((frame) => {
        if (gone) return;
        if ("normal" in frame) setFitted({ id: target.id, normal: frame.normal });
        else setFitted({ id: target.id, error: "it isn't a plane" });
      })
      .catch((cause) => {
        if (!gone) setFitted({ id: target.id, error: (cause as Error).message });
      });
    return () => {
      gone = true;
    };
  }, [wantsPlate, plateTarget?.id, !!plateTarget?.load]);
  const plateError =
    gpFailed && plateTarget ? `Couldn't fit ${plateTarget.name}: ${fitted?.error}` : undefined;

  // A saved view: the planes, crosshair and window now, each pane's own view once they have turned.
  const [restoring, setRestoring] = useState<QuadState>();
  useEffect(() => {
    if (!restore) return;
    setOrientation(restore.orientation);
    setAligned(restore.aligned);
    setPoint(restore.point);
    if (restore.contrast) setContrast(restore.contrast);
    onLayout(restore.layout);
    setRestoring(restore);
  }, [restore]);
  // GP mounts once its plane is fitted; its saved view waits for it while GP is shown.
  useEffect(() => {
    if (!restoring) return;
    const waiting: QuadState["views"] = {};
    for (const [view, saved] of Object.entries(restoring.views) as [QuadView, PaneView][]) {
      const h = handles[view]?.current;
      if (h) h.show(saved);
      else if (view === "gp" && showsGp) waiting.gp = saved;
    }
    if (!waiting.gp) setRestoring(undefined);
    else if (Object.keys(restoring.views).length > 1)
      setRestoring({ ...restoring, views: waiting });
  }, [restoring, plate, showsGp]);

  const state = (): QuadState => ({
    orientation,
    aligned,
    point,
    contrast,
    layout: given,
    views: Object.fromEntries(
      VIEW_ORDER.flatMap((v) => {
        const at = handles[v]?.current?.view();
        return at ? [[v, at]] : [];
      }),
    ),
  });
  const save = () => onSave?.(state());

  // GP while its plane is being fitted holds its cell with a loading pane.
  const mounted: readonly QuadView[] =
    plate || showsGp ? VIEW_ORDER : VIEW_ORDER.filter((v) => v !== "gp");
  const ready = shown.every(
    (v) => !!contrast && status[v] !== undefined && status[v] !== "loading",
  );
  const latestReady = useRef(onReady);
  latestReady.current = onReady;
  useEffect(() => latestReady.current?.(ready), [ready]);
  useImperativeHandle(ref, () => ({
    state,
    async snapshot(maxBytes) {
      const host = area.current?.getBoundingClientRect();
      if (!ready || !host?.width || !host.height) return null;
      const scale = Math.min(globalThis.devicePixelRatio, SNAPSHOT_WIDTH / host.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(host.width * scale);
      canvas.height = Math.round(host.height * scale);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = tokenColor("--viewer-well");
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${Math.round(12 * scale)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = "top";
      for (const view of shown) {
        // Each pane draws and is copied in the same task: a WebGL buffer doesn't outlive it.
        const layers = handles[view]?.current?.layers() ?? [];
        const rect = layers[0]?.getBoundingClientRect();
        if (!rect?.width || !rect.height) return null;
        const x = (rect.left - host.left) * scale;
        const y = (rect.top - host.top) * scale;
        for (const layer of layers)
          ctx.drawImage(layer, x, y, rect.width * scale, rect.height * scale);
        // The pane's name, so the picture says which view is which.
        const name = labelOf(view);
        ctx.fillStyle = tokenColor("--viewer-chip");
        ctx.fillRect(x, y, ctx.measureText(name).width + 8 * scale, 18 * scale);
        ctx.fillStyle = tokenColor("--viewer-chip-fg");
        ctx.fillText(name, x + 4 * scale, y + 3 * scale);
      }
      return pngWithin(canvas, maxBytes);
    },
  }));

  const anatomyOf = (view: QuadView): Anatomy | undefined => {
    if (!planes || view === "3d") return undefined;
    // A tilted plane takes the colour of the grid plane nearest it.
    const axis = view === "gp" ? (plate ? nearestAxis(plate) : 0) : FRAME[view];
    return planes[PLANE_OF[axis]];
  };
  const planesKey = planes && `${planes.XY}|${planes.XZ}|${planes.YZ}`;
  // Stable per grid: the slices redraw their crosshair lines when it changes.
  const planeToken = useMemo(
    () => (axis: Axis) => (planes ? ANATOMY[planes[PLANE_OF[axis]]].token : undefined),
    [planesKey],
  );
  const styleOf = (view: QuadView) => {
    const a = anatomyOf(view);
    return a ? ANATOMY[a] : NEUTRAL;
  };
  /** The grid's own code for a view: XY, XZ, YZ, or the fitted plane's ("GP"). */
  const codeOf = (view: QuadView) => (view === "gp" ? (plateTarget?.code ?? "GP") : LABEL[view]);
  /**
   * A view's name: the anatomical plane where the grid's catalog entry says which it is, the
   * fitted plane's name for GP, else the grid's code.
   */
  const labelOf = (view: QuadView) => {
    if (view === "gp") return plateTarget ? capital(plateTarget.name.replace(/^the /, "")) : "GP";
    const anatomy = view === "3d" ? undefined : planes?.[PLANE_OF[FRAME[view]]];
    return anatomy ? capital(anatomy) : LABEL[view];
  };

  const cols = layout.full || layout.count === 1 ? "1fr" : `${split.col}fr ${1 - split.col}fr`;
  const rows = layout.full || layout.count < 4 ? "1fr" : `${split.row}fr ${1 - split.row}fr`;
  const cellOf = (view: QuadView) => {
    if (layout.full) return "1 / 1";
    const slot = layout.views.indexOf(view);
    return `${slot < 2 ? 1 : 2} / ${(slot % 2) + 1}`;
  };
  const setFull = (view: QuadView | null) => onLayout({ ...given, full: view && givenView(view) });
  /** Puts `view` in `slot`; GP after a failed fit tries the fit again. */
  const pick = (slot: number, view: QuadView) => {
    if (view === "gp" && gpFailed) setFitted(undefined);
    onLayout(showIn(given, slot, view));
  };

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
  /** A mark made in `view`, with that pane's frame. */
  const markIn = useCallback(
    (view: QuadView) => (m: GridMark) => {
      const { onMark: made, orientation: o, plate: gp } = latestMark.current;
      const basis = view === "3d" ? null : view === "gp" ? basisAlong(gp!) : o[FRAME[view]];
      made?.(m, basis && { ...basis, view: view as MarkPlane["view"] });
    },
    [],
  );
  /** An end dragged in slice `view`, in that pane's frame. */
  const editIn = useCallback(
    (view: Exclude<QuadView, "3d">) => (edit: MarkEdit) => {
      const { onEdit: edited, orientation: o, plate: gp } = latestMark.current;
      const basis = view === "gp" ? basisAlong(gp!) : o[FRAME[view]];
      edited?.(edit, { ...basis, view });
    },
    [],
  );
  const pickMark = useCallback((id?: string) => latestMark.current.onPick?.(id), []);
  const tilts = useMemo(
    () =>
      ([0, 1, 2] as const).map((axis) => (angle: number) => {
        setOrientation((o) => tilt(o, axis, angle));
        setAligned(null);
      }),
    [],
  );
  /** Turn each plane's image in place, clockwise on screen; the other two planes follow. */
  const spins = useMemo(
    () =>
      ([0, 1, 2] as const).map((axis) => (angle: number) => {
        setOrientation((o) => spin(o, axis, angle));
        setAligned(null);
      }),
    [],
  );
  const cutsOf = (normals: readonly { axis: Axis; normal: Vec3 }[]) =>
    normals.map((c) => ({ ...c, token: planeToken(c.axis) }));
  // The pane in the top-left corner: the one filling the views, else slot 0.
  const corner = layout.full ?? layout.views[0];

  if (!hasWebGL())
    return (
      <section
        className="grid h-full place-items-center bg-background p-6 text-sm"
        aria-label="Views"
      >
        <div className="grid max-w-md gap-2">
          <h2 className="font-medium text-foreground">The scan can't be drawn in this browser</h2>
          <p className="text-muted-foreground">
            The slices and 3D view need graphics acceleration (WebGL), which is turned off here. In
            Chrome, turn on Settings › System › "Use graphics acceleration when available", then
            relaunch Chrome.
          </p>
        </div>
      </section>
    );

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Views">
      {(notes.length > 0 || contrastError || alignError || plateError) && (
        <div className="grid gap-1 px-3 py-2 text-xs text-muted-foreground">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
          {contrastError && (
            <p className="text-destructive" role="alert">
              Couldn't load the image: {contrastError}
            </p>
          )}
          {alignError && (
            <p className="text-destructive" role="alert">
              {alignError}
            </p>
          )}
          {plateError && (
            <p className="text-destructive" role="alert">
              {plateError}
            </p>
          )}
        </div>
      )}
      <div
        ref={area}
        className="relative grid min-h-0 flex-1"
        style={{ gridTemplateColumns: cols, gridTemplateRows: rows, gap: GAP }}
      >
        {mounted.map((view) => {
          const label = labelOf(view);
          const visible = shown.includes(view);
          const isFull = layout.full === view;
          const slot = layout.views.indexOf(view);
          const look = styleOf(view);
          let pane: ReactNode;
          if (view === "3d")
            pane = (
              <Grid3D
                scene={scene}
                planes={
                  planesIn3d
                    ? {
                        at: point,
                        cuts: ([0, 1, 2] as const).map((axis) => ({
                          normal: orientation[axis].normal,
                          color: tokenColor(planeToken(axis) ?? axisToken(axis)),
                        })),
                      }
                    : undefined
                }
                contrast={contrast}
                onPoint={setPoint}
                handle={handles[view]!}
                onStatus={onStatus(view)}
                tool={tool}
                marks={marks}
                onMark={markIn(view)}
                onPick={pickMark}
              />
            );
          else if (view === "gp" && !plate)
            pane = (
              <div className={PANE}>
                <span className={cx(CHIP, "top-2 right-2")} role="status">
                  Fitting {plateTarget?.name ?? "the plane"}…
                </span>
              </div>
            );
          else if (view === "gp")
            pane = (
              <SlicePane
                axis={nearestAxis(plate!)}
                basis={basisAlong(plate!)}
                cuts={cutsOf(
                  orientation.map((b, axis) => ({ axis: axis as Axis, normal: b.normal })),
                )}
                scene={scene}
                point={point}
                onPoint={setPoint}
                contrast={contrast}
                handle={handles[view]!}
                onStatus={onStatus(view)}
                tool={tool}
                marks={marks}
                onMark={markIn(view)}
                onEdit={onEdit && editIn(view)}
                onPick={pickMark}
              />
            );
          else {
            const axis = FRAME[view];
            pane = (
              <SlicePane
                axis={axis}
                basis={orientation[axis]}
                cuts={cutsOf(
                  ([0, 1, 2] as const)
                    .filter((a) => a !== axis)
                    .map((a) => ({ axis: a, normal: orientation[a].normal })),
                )}
                scene={scene}
                point={point}
                onPoint={setPoint}
                contrast={contrast}
                handle={handles[view]!}
                onStatus={onStatus(view)}
                tool={tool}
                marks={marks}
                onMark={markIn(view)}
                onEdit={onEdit && editIn(view)}
                onPick={pickMark}
                onTilt={tilts[axis]}
                onSpin={spins[axis]}
                planeToken={planeToken}
              />
            );
          }
          return (
            <section
              key={view}
              aria-label={label}
              hidden={!visible}
              className="relative flex min-h-0 min-w-0 flex-col overflow-hidden [&[hidden]]:hidden"
              style={{ gridArea: cellOf(view) }}
              onDoubleClick={(event) => {
                // With a marking tool a click marks; only Navigate fills the centre.
                if (tool || (event.target as HTMLElement).closest("button, input, [role=menu]"))
                  return;
                setFull(isFull ? null : view);
              }}
            >
              {pane}
              {heading && view === corner && (
                // A slice pane's number and slider own its top-left corner.
                <div
                  className={cx(
                    "absolute top-2 z-30 flex",
                    view === "3d"
                      ? "left-2 max-w-[calc(100%-3rem)]"
                      : "left-24 max-w-[calc(100%-7rem)]",
                  )}
                >
                  {heading}
                </div>
              )}
              <div
                aria-hidden
                className={cx("pointer-events-none absolute inset-0 z-10 inset-ring-1", look.ring)}
              />
              <div className="absolute right-2 bottom-2 z-20 flex items-center gap-1">
                <IconButton
                  size="sm"
                  label={isFull ? "Back to the panes" : `Fill the views with ${label}`}
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
                  labelOf={labelOf}
                  codeOf={codeOf}
                  plate={plateTarget}
                  onPick={(next) => pick(slot, next)}
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
        className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-border bg-card px-2 py-1"
      >
        {children}
        <span className="flex-1" />
        {lie && (
          <span className="truncate text-xs text-muted-foreground" role="status">
            {lie}
          </span>
        )}
        <Popover
          label="Planes"
          align="end"
          side="top"
          className="w-80"
          trigger={
            <IconButton size="sm" label="Planes">
              <Rotate3d aria-hidden />
            </IconButton>
          }
        >
          <div className="grid gap-3 text-xs">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={planesIn3d}
                onChange={(event) => setPlanesIn3d(event.target.checked)}
              />
              Show the planes in 3D
            </label>
            <p role="status" className="font-medium text-sm">
              {lie ?? (gridName ? `Along the ${lower(gridName)}` : "On the grid's axes")}
            </p>
            {targets.length > 0 && (
              <section className="grid gap-0.5">
                <h3 className="pb-1 text-muted-foreground">Align the planes</h3>
                {targets.map((t) => (
                  <Button
                    key={t.id}
                    size="sm"
                    variant="ghost"
                    className="justify-between"
                    disabled={!t.load || !!aligning}
                    onClick={() => void align(t)}
                  >
                    <span>Along {t.name}</span>
                    {(t.reason ?? t.tag) && (
                      <span className="font-normal text-fg-subtle text-xs">
                        {t.reason ?? t.tag}
                      </span>
                    )}
                  </Button>
                ))}
              </section>
            )}
            <section className="grid gap-1">
              <h3 className="pb-1 text-muted-foreground">Turn one view's image</h3>
              {(["xy", "xz", "yz"] as const).map((view) => {
                const axis = FRAME[view];
                const name = labelOf(view);
                return (
                  <div key={view} className="flex items-center gap-1">
                    <span className={cx("size-3 shrink-0 rounded-[2px]", styleOf(view).swatch)} />
                    <span className="mr-auto pr-3 pl-1">{name}</span>
                    {TURNS.map((by) => (
                      <Button
                        key={by}
                        size="sm"
                        variant="ghost"
                        aria-label={`Turn the ${name} image ${Math.abs(by)}° ${by < 0 ? "anticlockwise" : "clockwise"}`}
                        onClick={() => spins[axis]!((by * Math.PI) / 180)}
                      >
                        {by < 0 ? <RotateCcw /> : <RotateCw />}
                        {Math.abs(by)}°
                      </Button>
                    ))}
                  </div>
                );
              })}
              <p className="text-muted-foreground">
                Alt-drag in a slice turns it; <Key>,</Key> <Key>.</Key> by 1°, with Shift 0.1°
              </p>
            </section>
            <Button size="sm" disabled={!lie} onClick={reset} className="justify-self-start">
              <RotateCcw aria-hidden />
              {gridName ? `Back along the ${lower(gridName)}` : "Back to the grid's axes"}
            </Button>
          </div>
        </Popover>
        {contrast && (
          <Popover
            label="Contrast"
            align="end"
            side="top"
            className="w-auto"
            trigger={
              <IconButton size="sm" label="Contrast">
                <SunMedium aria-hidden />
              </IconButton>
            }
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <NumberField
                label="Black at"
                value={contrast.low}
                onCommit={(low) => setContrast({ ...contrast, low })}
              />
              <NumberField
                label="White at"
                value={contrast.high}
                onCommit={(high) => setContrast({ ...contrast, high })}
              />
              {scene.imageUnit && <span>{unitAsWritten(scene.imageUnit)}</span>}
            </div>
          </Popover>
        )}
        <fieldset className="flex">
          <legend className="sr-only">Views</legend>
          {(
            [
              [1, "One view", <Square key="1" />],
              [2, "Two views", <Columns2 key="2" />],
              [4, "Four views", <Grid2x2 key="4" />],
            ] as const
          ).map(([count, label, icon]) => (
            <IconButton
              key={count}
              size="sm"
              label={label}
              aria-pressed={layout.count === count && !layout.full}
              className="aria-pressed:bg-secondary aria-pressed:text-foreground"
              onClick={() => onLayout({ ...given, count, full: null })}
            >
              {icon}
            </IconButton>
          ))}
        </fieldset>
        {onSave && (
          <Button size="sm" onClick={save}>
            <Bookmark aria-hidden />
            Save view
          </Button>
        )}
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
  labelOf,
  codeOf,
  plate,
  onPick,
}: {
  view: QuadView;
  look: string;
  layout: QuadLayout;
  styleOf(view: QuadView): { swatch: string };
  labelOf(view: QuadView): string;
  codeOf(view: QuadView): string;
  /** The fitted plane GP shows; none, and GP isn't offered. */
  plate: PlaneTarget | undefined;
  onPick(view: QuadView): void;
}) {
  const shownElsewhere = (v: QuadView) =>
    v !== view && layout.views.slice(0, layout.count).includes(v);
  const offered = VIEW_ORDER.filter((v) => v !== "gp" || plate);
  return (
    <Menu
      align="end"
      className="w-72"
      trigger={
        <button
          type="button"
          aria-label={`${labelOf(view)}: show another view in this pane`}
          className={cx(
            "flex h-6 cursor-pointer items-center gap-0.5 rounded-sm pr-1 pl-1.5 text-xs font-medium",
            look,
          )}
        >
          {labelOf(view)}
          <ChevronDown aria-hidden className="size-3" />
        </button>
      }
    >
      {offered.map((v) => {
        const reason = v === "gp" ? plate?.reason : undefined;
        return (
          <MenuItem
            key={v}
            disabled={!!reason}
            icon={<span className={cx("size-3 rounded-[2px]", styleOf(v).swatch)} />}
            onSelect={() => onPick(v)}
          >
            <span className="flex items-baseline justify-between gap-3">
              <span>
                {labelOf(v)}
                {labelOf(v) !== codeOf(v) && (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{codeOf(v)}</span>
                )}
              </span>
              <span className="text-xs text-fg-subtle">
                {v === view ? "Shown" : (reason ?? (shownElsewhere(v) ? "Swaps" : ""))}
              </span>
            </span>
          </MenuItem>
        );
      })}
    </Menu>
  );
}
