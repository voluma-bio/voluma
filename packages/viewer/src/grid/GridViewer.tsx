/**
 * Review of one analysis grid: 3D plus three slice panes through one crosshair, all from the
 * grid's converted review assets. Panes resize and maximize without remounting. The crosshair
 * moves only when the user moves it; loading data never moves it or the camera.
 *
 * With `marking` on, a click on a slice marks a voxel and a drag marks a box (`onMark`); the
 * caller holds the marks and passes them back to be drawn. `ref` takes a PNG of the panes as
 * they show.
 */
import { Maximize2, Minimize2 } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { autoWindow, type Window } from "./compose";
import { Grid3D } from "./Grid3D";
import type { Picture } from "./picture";
import { readLevel } from "./planes";
import { type Capture, SlicePane } from "./SlicePane";
import type { Axis, GridMark, GridScene, Zyx } from "./scene";

export type GridViewerHandle = {
  /**
   * The visible panes as one PNG, laid out as on screen, at most `maxBytes` (it shrinks the
   * picture until it fits); null if even the smallest is larger.
   */
  snapshot(maxBytes: number): Promise<Blob | null>;
};

/** Widths, CSS px, a snapshot tries in turn until its PNG fits. */
const SNAPSHOT_WIDTHS = [1600, 1200, 800, 560];
const NO_MARKS: readonly GridMark[] = [];

const panes = [
  { id: "3d", label: "3D", axis: null },
  { id: "axial", label: "Axial", axis: 0, letter: "Z" },
  { id: "coronal", label: "Coronal", axis: 2, letter: "X" },
  { id: "sagittal", label: "Sagittal", axis: 1, letter: "Y" },
] as const;

export function GridViewer({
  scene,
  point: initialPoint,
  marking = false,
  marks = NO_MARKS,
  onMark,
  ref,
  children,
}: {
  /** Remount (`key`) for another grid: the panes keep their grid for life. */
  scene: GridScene;
  /** Where the crosshair starts; the grid's centre when absent. */
  point?: Zyx;
  /** Clicks and drags on the slices mark instead of moving the crosshair. */
  marking?: boolean;
  marks?: readonly GridMark[];
  onMark?(mark: GridMark): void;
  ref?: Ref<GridViewerHandle>;
  children?: ReactNode;
}) {
  const [maximized, setMaximized] = useState<string | null>(null);
  const [point, setPoint] = useState<Zyx>(
    () => initialPoint ?? (scene.shapeZyx.map((n) => Math.floor(n / 2)) as unknown as Zyx),
  );
  const [window, setWindow] = useState<Window | null>(null);
  const [windowError, setWindowError] = useState<string>();
  const [pictures, setPictures] = useState<Partial<Record<Axis, Picture>>>({});
  const onPicture = useCallback(
    (picture: Picture) => setPictures((all) => ({ ...all, [picture.axis]: picture })),
    [],
  );
  const latestMark = useRef(onMark);
  latestMark.current = onMark;
  const mark = useCallback((m: GridMark) => latestMark.current?.(m), []);

  // Each pane registers how to draw itself now, for the snapshot.
  const grid = useRef<HTMLDivElement>(null);
  const captures = useRef(new Map<string, Capture>());
  const [register] = useState(
    () =>
      Object.fromEntries(
        panes.map((p) => [
          p.id,
          (capture: Capture | null) =>
            void (capture ? captures.current.set(p.id, capture) : captures.current.delete(p.id)),
        ]),
      ) as Record<(typeof panes)[number]["id"], (capture: Capture | null) => void>,
  );
  useImperativeHandle(ref, () => ({
    async snapshot(maxBytes) {
      const host = grid.current!.getBoundingClientRect();
      // Render every pane once, then copy them while their buffers still hold the frame.
      const shots = [...captures.current].flatMap(([, capture]) => {
        const canvas = capture();
        const rect = canvas.getBoundingClientRect();
        return rect.width && rect.height ? [{ canvas, rect }] : [];
      });
      const sheets = SNAPSHOT_WIDTHS.map((width) => {
        const scale = Math.min(1, width / host.width) * globalThis.devicePixelRatio;
        const sheet = document.createElement("canvas");
        sheet.width = Math.round(host.width * scale);
        sheet.height = Math.round(host.height * scale);
        const ctx = sheet.getContext("2d")!;
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(
          "--viewer-well",
        );
        ctx.fillRect(0, 0, sheet.width, sheet.height);
        for (const { canvas, rect } of shots)
          ctx.drawImage(
            canvas,
            (rect.left - host.left) * scale,
            (rect.top - host.top) * scale,
            rect.width * scale,
            rect.height * scale,
          );
        return sheet;
      });
      for (const sheet of sheets) {
        const blob = await new Promise<Blob | null>((done) => sheet.toBlob(done, "image/png"));
        if (blob && blob.size <= maxBytes) return blob;
      }
      return null;
    },
  }));

  // The window spans the coarsest level's values, so the first picture already uses it.
  useEffect(() => {
    const abort = new AbortController();
    const coarsest = scene.image.levels.at(-1)!;
    readLevel(scene.image.base, coarsest.path, abort.signal)
      .then((level) => setWindow(autoWindow(level.data)))
      .catch((cause) => {
        if (!abort.signal.aborted) setWindowError((cause as Error).message);
      });
    return () => abort.abort();
  }, [scene.image]);

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
              <button
                type="button"
                className="icon-button"
                aria-label={`${isMax ? "Restore" : "Maximize"} ${pane.label}`}
                onClick={() => setMaximized(isMax ? null : pane.id)}
              >
                {isMax ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            </header>
            {pane.axis === null ? (
              <Grid3D
                scene={scene}
                pictures={pictures}
                onPoint={setPoint}
                marks={marks}
                onCapture={register[pane.id]}
              />
            ) : (
              <SlicePane
                axis={pane.axis}
                scene={scene}
                point={point}
                onPoint={setPoint}
                window={window}
                onPicture={onPicture}
                marking={marking}
                marks={marks}
                onMark={mark}
                onCapture={register[pane.id]}
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
        <h2 className="font-medium">Imaging workspace</h2>
        <div className="grid-toolbar">
          <output className="font-mono" aria-label="Crosshair voxel (z, y, x)">
            z {point[0]} · y {point[1]} · x {point[2]}
          </output>
          {window && (
            <>
              <label>
                Window low
                <input
                  type="number"
                  value={Math.round(window.low)}
                  onChange={(e) => {
                    const low = e.target.valueAsNumber;
                    if (Number.isFinite(low)) setWindow({ ...window, low });
                  }}
                />
              </label>
              <label>
                high
                <input
                  type="number"
                  value={Math.round(window.high)}
                  onChange={(e) => {
                    const high = e.target.valueAsNumber;
                    if (Number.isFinite(high)) setWindow({ ...window, high });
                  }}
                />
              </label>
            </>
          )}
          {children}
        </div>
      </div>
      {windowError && (
        <p className="error-message" role="alert">
          Couldn't load the image: {windowError}
        </p>
      )}
      <div className="viewer-grid" ref={grid}>
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
    </section>
  );
}
