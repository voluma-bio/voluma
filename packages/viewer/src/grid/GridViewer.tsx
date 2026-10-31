/**
 * Review of one analysis grid: 3D plus three slice panes through one crosshair, all from the
 * grid's converted review assets. Panes resize and maximize without remounting. The crosshair
 * moves when the user moves it, a new `focus` arrives or a saved view is restored; loading data
 * never moves it or the camera. Each pane can be captured as a screenshot with its view.
 *
 * With a marking `tool`, clicks and drags mark instead (`onMark`, grid voxels); the caller holds
 * the marks and passes them back to be drawn. `ref` gives `snapshot`: the panes as on screen,
 * marks included, as one PNG.
 */
import { cx, IconButton } from "@voluma/ui";
import { Camera, Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { autoContrast, type Contrast } from "./compose";
import { Grid3D } from "./Grid3D";
import { readLevel } from "./planes";
import { SlicePane } from "./SlicePane";
import type {
  GridMark,
  GridScene,
  MarkTool,
  PaneHandle,
  PaneStatus,
  PaneView,
  ShownMark,
  Zyx,
} from "./scene";
import { tokenColor } from "./token-color";

const panes = [
  { id: "3d", label: "3D", axis: null },
  { id: "axial", label: "Axial", axis: 0, letter: "Z" },
  { id: "coronal", label: "Coronal", axis: 2, letter: "X" },
  { id: "sagittal", label: "Sagittal", axis: 1, letter: "Y" },
] as const;

export type PaneId = (typeof panes)[number]["id"];

/** One pane's view with the crosshair and contrast: what a screenshot saves and restores. */
export type ViewerState = { pane: PaneId; point: Zyx; contrast: Contrast; view: PaneView };

export type GridViewerHandle = {
  /**
   * The shown panes as one PNG, laid out as on screen with their names, at most `maxBytes`. While
   * a pane refines it waits (at most `SETTLE_MS`), then reads the panes as they are after the
   * wait, not at the call: a slice moved meanwhile shows its new index in its name. A 3D pane
   * still sharpening is taken as it is. It gives null while a shown pane has no picture
   * (`onReady`), when a slice still shows a stand-in after the wait, or when no copy fits. A
   * failed pane is drawn as it is, its name marked incomplete. Callers capture their marks and
   * grid identity before awaiting it.
   */
  snapshot(maxBytes: number): Promise<Blob | null>;
};

/** How long a snapshot waits for a refining slice before giving up (ms). */
const SETTLE_MS = 3000;
/** Picture widths, in pixels, a snapshot tries in turn until one fits. */
const SNAPSHOT_WIDTHS = [1600, 1200, 800, 560, 400];
const NO_MARKS: readonly ShownMark[] = [];

/** Each slice plane keeps its axis colour (DESIGN.md): axial z, sagittal y, coronal x. */
const AXIS_INK: Record<string, string> = {
  axial: "text-axis-z-text",
  sagittal: "text-axis-y-text",
  coronal: "text-axis-x-text",
};

export function GridViewer({
  scene,
  title = "Imaging workspace",
  focus,
  notes = [],
  children,
  footer,
  restore,
  onCapture,
  saving = false,
  tool = null,
  marks = NO_MARKS,
  onMark,
  onReady,
  ref,
}: {
  /**
   * Remount (`key`) for another grid: the panes keep their grid for life. On the same grid,
   * new overlays or meshes (display settings) redraw in place.
   */
  scene: GridScene;
  title?: string;
  /** A voxel to centre the crosshair on: each new object moves it there once (a check's focus). */
  focus?: { at: Zyx };
  /** What the viewer should say it doesn't show. */
  notes?: string[];
  /** Toolbar controls. */
  children?: ReactNode;
  /** Below the panes. */
  footer?: ReactNode;
  /** A saved view on this grid: each new object is applied once, over any `focus`. */
  restore?: ViewerState;
  /** Shows a screenshot button on each pane; the PNG is the pane's canvas in device pixels. */
  onCapture?(state: ViewerState, png: { base64: string; width: number; height: number }): void;
  /** A screenshot is being saved: the screenshot buttons wait. */
  saving?: boolean;
  /** What a left click or drag makes; none (the default) moves the crosshair. */
  tool?: MarkTool | null;
  marks?: readonly ShownMark[];
  onMark?(mark: GridMark): void;
  /**
   * Whether a snapshot will picture the shown panes: each has a picture. A slice catching up
   * with a new slice or level doesn't change it; the snapshot waits for it.
   */
  onReady?(ready: boolean): void;
  ref?: Ref<GridViewerHandle>;
}) {
  const [maximized, setMaximized] = useState<string | null>(null);
  const [point, setPoint] = useState<Zyx>(
    () =>
      restore?.point ??
      focus?.at ??
      (scene.shapeZyx.map((n) => Math.floor(n / 2)) as unknown as Zyx),
  );
  useEffect(() => {
    if (focus) setPoint(focus.at);
  }, [focus]);
  const [contrast, setContrast] = useState<Contrast | null>(restore?.contrast ?? null);
  const [contrastError, setContrastError] = useState<string>();
  // A pane short of its picture holds pictures back: a screenshot would keep that state for good.
  const [status, setStatus] = useState<Record<string, PaneStatus>>({});
  const pictured = (id: PaneId) =>
    !!contrast &&
    contrast.low < contrast.high &&
    status[id] !== undefined &&
    status[id] !== "loading";
  const settled = (id: PaneId) => pictured(id) && status[id] !== "refining";
  const shownPanes = panes.filter((p) => !maximized || maximized === p.id);
  const ready = shownPanes.every((p) => pictured(p.id));
  const steady = shownPanes.every((p) => settled(p.id));
  // A refining slice shows a stand-in (another index or level); a refining 3D pane only a coarser volume.
  const standIn = shownPanes.some((p) => p.axis !== null && status[p.id] === "refining");
  const latestReady = useRef(onReady);
  latestReady.current = onReady;
  useEffect(() => latestReady.current?.(ready), [ready]);
  // A snapshot taken while a pane refines waits for it, then reads the panes as they are then.
  const now = useRef<{
    ready: boolean;
    steady: boolean;
    standIn: boolean;
    sheet(host: DOMRect, scale: number): HTMLCanvasElement | null;
  }>(null);
  const waiting = useRef<(() => void)[]>([]);
  useEffect(() => {
    if (steady) for (const go of waiting.current.splice(0)) go();
  }, [steady]);
  const handles = useRef(
    Object.fromEntries(panes.map((p) => [p.id, { current: null as PaneHandle | null }])),
  ).current;
  const latestMark = useRef(onMark);
  latestMark.current = onMark;
  const [mark] = useState(() => (m: GridMark) => latestMark.current?.(m));
  const grid = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    async snapshot(maxBytes) {
      if (!ready) return null;
      if (!now.current?.steady)
        await new Promise<void>((go) => {
          waiting.current.push(go);
          setTimeout(go, SETTLE_MS);
        });
      const host = grid.current?.getBoundingClientRect();
      const latest = now.current;
      if (!host?.width || !host.height || !latest?.ready || latest.standIn) return null;
      const scale = Math.min(globalThis.devicePixelRatio, SNAPSHOT_WIDTHS[0]! / host.width);
      // Freeze every pane before encoding: later encodes must not reread live viewer state.
      const frozen = latest.sheet(host, scale);
      if (!frozen) return null;
      let tried = 0;
      for (const width of SNAPSHOT_WIDTHS) {
        const size = Math.min(frozen.width, width);
        if (size === tried) continue;
        tried = size;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = Math.round((size / frozen.width) * frozen.height);
        canvas.getContext("2d")!.drawImage(frozen, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
        if (blob && blob.size <= maxBytes) return blob;
      }
      return null;
    },
  }));
  /** The shown panes as one PNG, `scale` picture pixels to a CSS pixel of the grid. */
  const sheet = (host: DOMRect, scale: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(host.width * scale);
    canvas.height = Math.round(host.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = tokenColor("--viewer-well");
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${Math.round(12 * scale)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    for (const pane of shownPanes) {
      // Each pane draws and is copied in the same task: a WebGL buffer doesn't outlive it.
      const layers = handles[pane.id]!.current?.layers() ?? [];
      const rect = layers[0]?.getBoundingClientRect();
      if (!rect?.width || !rect.height) return null;
      const x = (rect.left - host.left) * scale;
      const y = (rect.top - host.top) * scale;
      for (const layer of layers)
        ctx.drawImage(layer, x, y, rect.width * scale, rect.height * scale);
      // The pane's name, so the picture says which view is which, and whether it is all there.
      const place = pane.axis === null ? pane.label : `${pane.label} ${point[pane.axis] + 1}`;
      const name = status[pane.id] === "failed" ? `${place} (incomplete)` : place;
      ctx.fillStyle = tokenColor("--viewer-chip");
      ctx.fillRect(x, y, ctx.measureText(name).width + 8 * scale, 18 * scale);
      ctx.fillStyle = tokenColor("--viewer-chip-fg");
      ctx.fillText(name, x + 4 * scale, y + 3 * scale);
    }
    return canvas;
  };
  now.current = { ready, steady, standIn, sheet };
  // After the focus effect, so a restored crosshair wins when both arrive together.
  useEffect(() => {
    if (!restore) return;
    setPoint(restore.point);
    setContrast(restore.contrast);
    setMaximized((m) => (m && m !== restore.pane ? null : m));
    handles[restore.pane]!.current?.show(restore.view);
  }, [restore, handles]);

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

  // A drag handle shows a hairline on hover or focus; hidden while a pane is maximized.
  const handle = cx(
    "relative shrink-0 after:absolute after:bg-transparent after:content-[''] hover:after:bg-primary focus-visible:after:bg-primary",
    maximized && "invisible",
  );
  const slot = (pane: (typeof panes)[number], showSeparator: boolean) => {
    const isMax = maximized === pane.id;
    return (
      <>
        {showSeparator && (
          <Separator
            className={cx(handle, "w-2 after:inset-y-0 after:left-1/2 after:w-px")}
            aria-label={`Resize ${pane.label}`}
          />
        )}
        <Panel id={pane.id} minSize="20%" defaultSize="50%">
          <section
            className={cx(
              "flex h-full flex-col overflow-hidden rounded-md border border-border bg-muted [&[hidden]]:hidden",
              isMax && "absolute inset-0 z-10",
            )}
            aria-label={pane.label}
            hidden={maximized !== null && !isMax}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest("header"))
                setMaximized(isMax ? null : pane.id);
            }}
          >
            <header className="flex items-center justify-between gap-1 border-b border-border px-3 py-1">
              <h3 className="flex items-center gap-2 text-xs font-medium">
                {pane.axis !== null && (
                  <span className={cx("font-mono", AXIS_INK[pane.id])}>{pane.letter}</span>
                )}
                {pane.label}
              </h3>
              <div className="flex">
                {onCapture && (
                  <IconButton
                    size="sm"
                    label={`Save screenshot of ${pane.label}`}
                    disabled={!settled(pane.id) || saving}
                    onClick={() => {
                      const shot = handles[pane.id]!.current?.capture();
                      if (shot && contrast)
                        onCapture(
                          { pane: pane.id, point, contrast, view: shot.view },
                          { base64: shot.pngBase64, width: shot.width, height: shot.height },
                        );
                    }}
                  >
                    <Camera />
                  </IconButton>
                )}
                <IconButton
                  size="sm"
                  label={`${isMax ? "Restore" : "Maximize"} ${pane.label}`}
                  onClick={() => setMaximized(isMax ? null : pane.id)}
                >
                  {isMax ? <Minimize2 /> : <Maximize2 />}
                </IconButton>
              </div>
            </header>
            {pane.axis === null ? (
              <Grid3D
                scene={scene}
                contrast={contrast}
                onPoint={setPoint}
                handle={handles[pane.id]!}
                onStatus={(next) =>
                  setStatus((had) => (had[pane.id] === next ? had : { ...had, [pane.id]: next }))
                }
                tool={tool}
                marks={marks}
                onMark={mark}
              />
            ) : (
              <SlicePane
                axis={pane.axis}
                scene={scene}
                point={point}
                onPoint={setPoint}
                contrast={contrast}
                handle={handles[pane.id]!}
                onStatus={(next) =>
                  setStatus((had) => (had[pane.id] === next ? had : { ...had, [pane.id]: next }))
                }
                tool={tool}
                marks={marks}
                onMark={mark}
              />
            )}
          </section>
        </Panel>
      </>
    );
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background p-4"
      aria-label="Imaging workspace"
    >
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-2 text-sm">
        <h2 className="font-medium">{title}</h2>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <output className="flex gap-2 font-mono" aria-label="Crosshair voxel (z, y, x)">
            <span>z {point[0]}</span>
            <span>y {point[1]}</span>
            <span>x {point[2]}</span>
          </output>
          {contrast && (
            <>
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
            </>
          )}
          {children}
        </div>
      </div>
      {notes.map((note) => (
        <p key={note} className="text-xs text-muted-foreground mb-2">
          {note}
        </p>
      ))}
      {contrastError && (
        <p className="rounded-md bg-destructive-tint p-3 text-sm text-destructive" role="alert">
          Couldn't load the image: {contrastError}
        </p>
      )}
      <div
        ref={grid}
        className={cx(
          "relative min-h-0 flex-1 [&_[data-group]]:h-full",
          // Panels clip their content inline; a maximized pane has to spill over its siblings.
          maximized && "[&_[data-panel]]:overflow-visible!",
        )}
      >
        <Group orientation="vertical" id="grid-rows">
          <Panel id="grid-top" defaultSize="50%" minSize="20%">
            <Group orientation="horizontal" id="grid-top-panes">
              {slot(panes[0], false)}
              {slot(panes[1], true)}
            </Group>
          </Panel>
          <Separator
            className={cx(handle, "h-2 w-full after:inset-x-0 after:top-1/2 after:h-px")}
            aria-label="Resize viewer rows"
          />
          <Panel id="grid-bottom" minSize="20%">
            <Group orientation="horizontal" id="grid-bottom-panes">
              {slot(panes[2], false)}
              {slot(panes[3], true)}
            </Group>
          </Panel>
        </Group>
      </div>
      {footer}
    </section>
  );
}

/**
 * A number typed freely (a lone "-", "0.") and applied on Enter or blur, so a half-typed value
 * never redraws every pane or snaps back.
 */
function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit(value: number): void;
}) {
  const shown = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const n = Number(draft);
    if (draft !== null && draft.trim() !== "" && Number.isFinite(n) && n !== value) onCommit(n);
    setDraft(null);
  };
  return (
    <label className="flex items-center gap-1">
      {label}
      <input
        className="h-7 w-20 rounded-md border border-border bg-card px-1 font-mono text-foreground"
        type="text"
        inputMode="decimal"
        value={draft ?? shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
      />
    </label>
  );
}
