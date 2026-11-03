/**
 * A bundled workflow's measurements as a researcher reads them: the values its catalog
 * (`outputs.yaml`, `outputCatalogOf`) declares, in catalog order, with their names and units.
 * Shown in "See measurements" (a side panel over Run on new samples, so the choice in progress
 * stays put) and on the Workflows page; the study pages read their columns and units from here.
 */
import { type OutputEntry, unitAsWritten } from "@voluma/contracts/output-catalog";
import { Button } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { outputCatalogOf } from "@voluma/workflow/output-catalogs";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";

/** A value the workflow can report: a number with a unit. */
export type Measurement = Extract<OutputEntry, { kind: "value" }>;

/** The workflow's measurements, in catalog order. */
export const measurementsOf = (workflow: Pick<BundledWorkflow, "path">): Measurement[] =>
  outputCatalogOf(workflow.path).filter((o): o is Measurement => o.kind === "value");

/** The measurements a study leads with (`headline` in the catalog), in catalog order. */
export const headlinesOf = (workflow: Pick<BundledWorkflow, "path">) =>
  measurementsOf(workflow).filter((o) => o.headline === true);

/** A measurement's unit as people write it (`mm³`, `HU`), the way a run's values carry it. */
export const unitOf = (output: Measurement) => unitAsWritten(output.unit);

export function MeasurementList({ workflow }: { workflow: Pick<BundledWorkflow, "path"> }) {
  return (
    <ul aria-label="Measurements" className="grid gap-1">
      {measurementsOf(workflow).map((o) => (
        <li key={o.id} className="flex items-baseline gap-2 text-sm">
          {o.name}
          <span className="text-fg-subtle">{unitOf(o)}</span>
        </li>
      ))}
    </ul>
  );
}

/** "See measurements": the workflow's measurements in a panel over the right side of the page. */
export function WorkflowPanel({
  workflow,
  open,
  onClose,
}: {
  workflow: BundledWorkflow;
  open: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes a modal <dialog>; the click is the pointer-only backdrop dismissal.
    <dialog
      ref={dialog}
      aria-label={`${workflow.name} measurements`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-0 ml-auto h-dvh max-h-none w-[min(30rem,100vw)] max-w-none border-l border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-scrim open:flex open:flex-col motion-safe:open:animate-[panel-in_160ms_ease-out]"
    >
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{workflow.name}</h2>
          <p className="text-sm text-muted-foreground">
            {measurementsOf(workflow).length} measurements
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-1 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <MeasurementList workflow={workflow} />
      </div>
      <footer className="border-t border-border px-5 py-3">
        {/* A new tab: leaving Run on new samples would drop the uploads under way. */}
        <Button asChild variant="link" className="text-sm">
          <Link to="/workflows" target="_blank" rel="noreferrer">
            Open in Workflows
            <ExternalLink aria-label="opens in a new tab" />
          </Link>
        </Button>
      </footer>
    </dialog>
  );
}
