/** Persistent viewport slots. Maximizing changes layout, never the identity of a view. */
import { Box, Layers, Maximize2, Minimize2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { DicomSeries } from "./dicom";

const DicomStack = lazy(() => import("./DicomStack"));
const DicomVolume = lazy(() => import("./DicomVolume"));

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

export function ViewerWorkspace({ series }: { series?: DicomSeries }) {
  const [maximized, setMaximized] = useState<string | null>(null);
  return (
    <section
      className={`viewer-workspace ${maximized ? "is-maximized" : ""}`}
      aria-label="Imaging workspace"
    >
      <div className="viewer-heading">
        <h2 className="font-medium">Imaging workspace</h2>
      </div>
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
}: {
  view: (typeof views)[number];
  showSeparator: boolean;
  maximized: string | null;
  onMaximize(id: string | null): void;
  series?: DicomSeries;
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
            <button
              type="button"
              className="icon-button"
              aria-label={`${isMax ? "Restore" : "Maximize"} ${view.label}`}
              onClick={() => onMaximize(isMax ? null : view.id)}
            >
              {isMax ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
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
                <DicomStack key={series.id} series={series} />
              ) : (
                <DicomVolume key={series.id} series={series} />
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
