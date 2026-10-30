/** Persistent viewport slots. Maximizing changes layout, never the identity of a view. */
import type { Focus, Revision, Structure } from "@voluma/contracts/review";
import { Button, IconButton } from "@voluma/ui";
import { Box, Layers, Maximize2, Minimize2 } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { DicomSeries } from "./dicom";
import { focusTarget, type LabelSource, type LabelVolume, type StructureDisplay } from "./labels";
import type { SnapshotControls } from "./snapshot";
import { useLabelVolumes } from "./useLabelVolumes";

const DicomStack = lazy(() => import("./DicomStack"));
const DicomVolume = lazy(() => import("./DicomVolume"));

export type { StructureDisplay } from "./labels";

const views = [
  {
    id: "surface",
    label: "3D",
    axis: "",
    description: "No scan loaded",
    icon: Box,
  },
  {
    id: "acquired",
    label: "Acquired slices",
    axis: "",
    description: "No scan loaded",
    icon: Layers,
  },
  {
    id: "coronal",
    label: "Coronal",
    axis: "X",
    description: "No coronal slices loaded",
    icon: Layers,
  },
  {
    id: "sagittal",
    label: "Sagittal",
    axis: "Y",
    description: "No sagittal slices loaded",
    icon: Layers,
  },
];

export function ViewerWorkspace({
  series,
  children,
  selected,
  display,
  revision,
  focus,
  fileUrl,
  snapshots,
}: {
  selected: Structure[];
  display: StructureDisplay;
  series?: DicomSeries;
  children?: ReactNode;
  revision?: Revision;
  focus?: Focus;
  fileUrl?: (sha256: string) => string;
  snapshots?: SnapshotControls;
}) {
  const [maximized, setMaximized] = useState<string | null>(null);
  const [labels, setLabels] = useState(true);
  useEffect(() => {
    if (snapshots?.restore) {
      setLabels(snapshots.restore.viewState.labelsEnabled);
      setMaximized("acquired");
    }
  }, [snapshots?.restore]);
  const selectedKey = selected.map((s) => s.id).join("\n");
  const structures = useMemo(
    () =>
      revision?.structures.filter(
        (s) => selectedKey.split("\n").includes(s.id) || focus?.on.includes(s.id),
      ) ?? [],
    [revision, selectedKey, focus],
  );
  const sources = useMemo<LabelSource[]>(() => {
    if (!fileUrl) return [];
    const ids = new Set(
      structures.flatMap((s) =>
        s.voxels && "label" in s.voxels && s.volumeId ? [s.volumeId] : [],
      ),
    );
    if (focus?.volumeId) ids.add(focus.volumeId);
    return (
      revision?.volumes.flatMap((volume) =>
        volume.kind === "labels" && ids.has(volume.id) && volume.data?.format === "npy"
          ? [{ volume, url: fileUrl(volume.data.sha256) }]
          : [],
      ) ?? []
    );
  }, [revision, structures, focus?.volumeId, fileUrl]);
  const loaded = useLabelVolumes(sources, series, revision?.id);
  const resolvedFocus = useMemo(() => {
    const target = focusTarget(
      focus,
      loaded.layers,
      structures,
      revision?.annotations ?? [],
      series,
    );
    return focus && target ? { ...focus, ...target } : undefined;
  }, [focus, loaded.layers, structures, revision?.annotations, series]);
  const badFocus =
    !!series &&
    !!resolvedFocus &&
    [resolvedFocus.point, resolvedFocus.box?.min, resolvedFocus.box?.max].some((p) =>
      p?.some((n, i) => n < 0 || n >= [series.slices.length, series.rows, series.columns][i]!),
    );
  const labelView = {
    layers: loaded.layers,
    structures,
    display,
    focus: badFocus ? undefined : resolvedFocus,
    labels,
  };
  return (
    <section
      className={`viewer-workspace ${maximized ? "is-maximized" : ""}`}
      aria-label="Imaging workspace"
    >
      <div className="viewer-heading">
        <h2 className="font-medium">Imaging workspace</h2>
        {children}
      </div>
      {sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs text-muted-foreground">
          <label>
            <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />{" "}
            Labels
          </label>
          <span role="status">
            {!series
              ? "Open the scan to load labels."
              : loaded.loading
                ? "Loading labels…"
                : `${loaded.layers.length} label volume${loaded.layers.length === 1 ? "" : "s"} loaded`}
          </span>
        </div>
      )}
      {loaded.error && (
        <p className="error-message" role="alert">
          {loaded.error}{" "}
          <Button variant="link" onClick={loaded.retry}>
            Retry labels
          </Button>
        </p>
      )}
      {badFocus && (
        <p className="error-message" role="alert">
          This check points outside the scan grid.
        </p>
      )}
      {snapshots?.tray}
      <div className="viewer-grid">
        <Group orientation="vertical" id="viewer-rows">
          <Panel id="top" defaultSize="50%" minSize="20%">
            <Group orientation="horizontal" id="top-views">
              {views.slice(0, 2).map((view, i) => (
                <ViewSlot
                  key={view.id}
                  view={view}
                  showSeparator={i > 0}
                  maximized={maximized}
                  onMaximize={setMaximized}
                  series={series}
                  labelView={labelView}
                  snapshots={snapshots}
                  labelsPending={loaded.loading || loaded.layers.length !== sources.length}
                />
              ))}
            </Group>
          </Panel>
          <Separator className="resize-handle horizontal" aria-label="Resize viewer rows" />
          <Panel id="bottom" minSize="20%">
            <Group orientation="horizontal" id="bottom-views">
              {views.slice(2).map((view, i) => (
                <ViewSlot
                  key={view.id}
                  view={view}
                  showSeparator={i > 0}
                  maximized={maximized}
                  onMaximize={setMaximized}
                  series={series}
                  labelView={labelView}
                />
              ))}
            </Group>
          </Panel>
        </Group>
      </div>
    </section>
  );
}

function ViewSlot({
  view,
  showSeparator,
  maximized,
  onMaximize,
  series,
  labelView,
  snapshots,
  labelsPending,
}: {
  view: (typeof views)[number];
  showSeparator: boolean;
  maximized: string | null;
  onMaximize(id: string | null): void;
  series?: DicomSeries;
  snapshots?: SnapshotControls;
  labelsPending?: boolean;
  labelView: {
    layers: LabelVolume[];
    structures: Structure[];
    display: StructureDisplay;
    focus?: Focus;
    labels: boolean;
  };
}) {
  const isMax = maximized === view.id;
  const Icon = view.icon;
  return (
    <>
      {showSeparator && (
        <Separator className="resize-handle" aria-label={`Resize ${view.label} view`} />
      )}
      <Panel id={view.id} minSize="20%" defaultSize="50%">
        <section
          className={`view-slot ${isMax ? "maximized" : ""}`}
          data-view={view.id}
          aria-label={view.label}
          hidden={maximized !== null && !isMax}
        >
          <header>
            <h3>
              {view.axis && <span className={`axis ${view.id}`}>{view.axis}</span>}
              {view.label}
            </h3>
            <IconButton
              label={`${isMax ? "Restore" : "Maximize"} ${view.label}`}
              size="sm"
              onClick={() => onMaximize(isMax ? null : view.id)}
            >
              {isMax ? <Minimize2 /> : <Maximize2 />}
            </IconButton>
          </header>
          {(view.id === "acquired" || view.id === "surface") && series ? (
            <Suspense
              fallback={
                <div className="view-empty" role="status">
                  Loading image viewer…
                </div>
              }
            >
              {view.id === "acquired" ? (
                <DicomStack
                  key={series.id}
                  series={series}
                  {...labelView}
                  snapshots={snapshots}
                  labelsPending={labelsPending}
                />
              ) : (
                <DicomVolume key={series.id} series={series} focus={labelView.focus} />
              )}
            </Suspense>
          ) : (
            <div className="view-empty">
              <Icon size={36} strokeWidth={1} />
              <p className="font-medium mt-4">{view.description}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {series
                  ? "Meshes and reformatted planes are not generated yet."
                  : "No scan has been opened."}
              </p>
            </div>
          )}
        </section>
      </Panel>
    </>
  );
}
