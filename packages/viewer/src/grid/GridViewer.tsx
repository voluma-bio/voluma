/**
 * Review of one analysis grid: 3D plus three slice panes through one crosshair, all from the
 * grid's converted review assets. Panes resize and maximize without remounting. The crosshair
 * moves only when the user moves it; loading data never moves it or the camera.
 */
import { Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { autoContrast, type Contrast } from "./compose";
import { Grid3D } from "./Grid3D";
import type { Picture } from "./picture";
import { readLevel } from "./planes";
import { SlicePane } from "./SlicePane";
import type { Axis, GridScene, Zyx } from "./scene";

const panes = [
  { id: "3d", label: "3D", axis: null },
  { id: "axial", label: "Axial", axis: 0, letter: "Z" },
  { id: "coronal", label: "Coronal", axis: 2, letter: "X" },
  { id: "sagittal", label: "Sagittal", axis: 1, letter: "Y" },
] as const;

export function GridViewer({
  scene,
  children,
}: {
  /** Remount (`key`) for another grid: the panes keep their grid for life. */
  scene: GridScene;
  children?: ReactNode;
}) {
  const [maximized, setMaximized] = useState<string | null>(null);
  const [point, setPoint] = useState<Zyx>(
    () => scene.shapeZyx.map((n) => Math.floor(n / 2)) as unknown as Zyx,
  );
  const [contrast, setContrast] = useState<Contrast | null>(null);
  const [contrastError, setContrastError] = useState<string>();
  const [pictures, setPictures] = useState<Partial<Record<Axis, Picture>>>({});
  const onPicture = useCallback(
    (axis: Axis, picture: Picture | null) =>
      setPictures((all) => ({ ...all, [axis]: picture ?? undefined })),
    [],
  );

  // The contrast spans the coarsest level's values, so the first picture already uses it.
  useEffect(() => {
    const abort = new AbortController();
    const coarsest = scene.image.levels.at(-1)!;
    readLevel(scene.image.base, coarsest.path, abort.signal)
      .then((level) => setContrast(autoContrast(level.data)))
      .catch((cause) => {
        if (!abort.signal.aborted) setContrastError((cause as Error).message);
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
              <Grid3D scene={scene} pictures={pictures} onPoint={setPoint} />
            ) : (
              <SlicePane
                axis={pane.axis}
                scene={scene}
                point={point}
                onPoint={setPoint}
                contrast={contrast}
                onPicture={onPicture}
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
