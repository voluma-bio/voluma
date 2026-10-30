/**
 * Review of one analysis grid: 3D plus three slice panes through one crosshair, all from the
 * grid's converted review assets. Panes resize and maximize without remounting. The crosshair
 * moves when the user moves it, a new `focus` arrives or a saved view is restored; loading data
 * never moves it or the camera. Each pane can be captured as a screenshot with its view.
 */
import { Camera, Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { autoContrast, type Contrast } from "./compose";
import { Grid3D } from "./Grid3D";
import { readLevel } from "./planes";
import { SlicePane } from "./SlicePane";
import type { GridScene, PaneHandle, PaneView, Zyx } from "./scene";

const panes = [
  { id: "3d", label: "3D", axis: null },
  { id: "axial", label: "Axial", axis: 0, letter: "Z" },
  { id: "coronal", label: "Coronal", axis: 2, letter: "X" },
  { id: "sagittal", label: "Sagittal", axis: 1, letter: "Y" },
] as const;

export type PaneId = (typeof panes)[number]["id"];

/** One pane's view with the crosshair and contrast: what a screenshot saves and restores. */
export type ViewerState = { pane: PaneId; point: Zyx; contrast: Contrast; view: PaneView };

export function GridViewer({
  scene,
  title = "Imaging workspace",
  focus,
  notes = [],
  children,
  footer,
  restore,
  onCapture,
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
  const handles = useRef(
    Object.fromEntries(panes.map((p) => [p.id, { current: null as PaneHandle | null }])),
  ).current;
  // After the focus effect, so a restored crosshair wins when both arrive together.
  useEffect(() => {
    if (!restore) return;
    setPoint(restore.point);
    setContrast(restore.contrast);
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

  const slot = (pane: (typeof panes)[number], showSeparator: boolean) => {
    const isMax = maximized === pane.id;
    return (
      <>
        {showSeparator && (
          <Separator className="resize-handle" aria-label={`Resize ${pane.label}`} />
        )}
        <Panel id={pane.id} minSize="20%" defaultSize="50%">
          <section
            className={`view-slot ${isMax ? "maximized" : ""}`}
            aria-label={pane.label}
            hidden={maximized !== null && !isMax}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest("header"))
                setMaximized(isMax ? null : pane.id);
            }}
          >
            <header>
              <h3>
                {pane.axis !== null && <span className={`axis ${pane.id}`}>{pane.letter}</span>}
                {pane.label}
              </h3>
              <div className="flex">
                {onCapture && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Save screenshot of ${pane.label}`}
                    title="Save screenshot"
                    disabled={!contrast}
                    onClick={() => {
                      const shot = handles[pane.id]!.current?.capture();
                      if (shot && contrast)
                        onCapture(
                          { pane: pane.id, point, contrast, view: shot.view },
                          { base64: shot.pngBase64, width: shot.width, height: shot.height },
                        );
                    }}
                  >
                    <Camera size={15} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${isMax ? "Restore" : "Maximize"} ${pane.label}`}
                  onClick={() => setMaximized(isMax ? null : pane.id)}
                >
                  {isMax ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                </button>
              </div>
            </header>
            {pane.axis === null ? (
              <Grid3D
                scene={scene}
                contrast={contrast}
                onPoint={setPoint}
                handle={handles[pane.id]!}
              />
            ) : (
              <SlicePane
                axis={pane.axis}
                scene={scene}
                point={point}
                onPoint={setPoint}
                contrast={contrast}
                handle={handles[pane.id]!}
              />
            )}
          </section>
        </Panel>
      </>
    );
  };

  return (
    <section
      className={`viewer-workspace ${maximized ? "is-maximized" : ""}`}
      aria-label="Imaging workspace"
    >
      <div className="viewer-heading">
        <h2 className="font-medium">{title}</h2>
        <div className="grid-toolbar">
          <output className="font-mono" aria-label="Crosshair voxel (z, y, x)">
            z {point[0]} · y {point[1]} · x {point[2]}
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
        <p className="error-message" role="alert">
          Couldn't load the image: {contrastError}
        </p>
      )}
      <div className="viewer-grid">
        <Group orientation="vertical" id="grid-rows">
          <Panel id="grid-top" defaultSize="50%" minSize="20%">
            <Group orientation="horizontal" id="grid-top-panes">
              {slot(panes[0], false)}
              {slot(panes[1], true)}
            </Group>
          </Panel>
          <Separator className="resize-handle horizontal" aria-label="Resize viewer rows" />
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
    <label>
      {label}
      <input
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
