/** Persistent viewport slots. Maximizing changes layout, never the identity of a view. */
import type { Structure } from "@voluma/contracts";
import { Box, Layers, Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

export type StructureDisplay = Record<
  string,
  { visible: boolean; opacity: number }
>;
const views = [
  {
    id: "surface",
    label: "3D surface",
    axis: "",
    description: "No mesh loaded",
    icon: Box,
  },
  {
    id: "axial",
    label: "Axial",
    axis: "Z",
    description: "No axial slices loaded",
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
  selected,
  display,
}: {
  selected: Structure[];
  display: StructureDisplay;
}) {
  const [maximized, setMaximized] = useState<string | null>(null);
  return (
    <section
      className={`viewer-workspace ${maximized ? "is-maximized" : ""}`}
      aria-label="Imaging workspace"
    >
      <div className="viewer-heading">
        <h2 className="font-medium">Imaging workspace</h2>
        <span className="text-xs text-muted-foreground">
          Viewer integration pending
        </span>
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
                />
              ))}
            </Group>
          </Panel>
          <Separator
            className="resize-handle horizontal"
            aria-label="Resize viewer rows"
          />
          <Panel id="bottom" minSize="20%">
            <Group orientation="horizontal" id="bottom-views">
              {views.slice(2).map((view, i) => (
                <ViewSlot
                  key={view.id}
                  view={view}
                  showSeparator={i > 0}
                  maximized={maximized}
                  onMaximize={setMaximized}
                />
              ))}
            </Group>
          </Panel>
        </Group>
      </div>
      <div className="viewer-selection">
        <span className="text-xs text-muted-foreground">Task structures</span>
        <div className="flex flex-wrap gap-2 mt-2">
          {selected.map((s) => (
            <span className="structure-chip" key={s.id}>
              {s.name}
              <span className="text-muted-foreground">
                {display[s.id]?.visible === false
                  ? "Hidden"
                  : `${display[s.id]?.opacity ?? 100}%`}
              </span>
            </span>
          ))}
          {selected.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No structures selected.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function ViewSlot({
  view,
  showSeparator,
  maximized,
  onMaximize,
}: {
  view: (typeof views)[number];
  showSeparator: boolean;
  maximized: string | null;
  onMaximize(id: string | null): void;
}) {
  const isMax = maximized === view.id;
  const Icon = view.icon;
  return (
    <>
      {showSeparator && (
        <Separator
          className="resize-handle"
          aria-label={`Resize ${view.label} view`}
        />
      )}
      <Panel id={view.id} minSize="20%" defaultSize="50%">
        <section
          className={`view-slot ${isMax ? "maximized" : ""}`}
          data-view={view.id}
          aria-label={`${view.label} placeholder`}
          hidden={maximized !== null && !isMax}
        >
          <header>
            <h3>
              <span className={`axis ${view.id}`}>{view.axis || "3D"}</span>
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
          <div className="view-empty">
            <Icon size={36} strokeWidth={1} />
            <p className="font-medium mt-4">{view.description}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Scientific images are not included.
            </p>
          </div>
          <footer>
            OA6-1RK<span>Placeholder</span>
          </footer>
        </section>
      </Panel>
    </>
  );
}
