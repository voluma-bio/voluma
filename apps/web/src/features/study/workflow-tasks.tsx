/**
 * A bundled workflow's tasks as a researcher reads them: each task's title, its `summary` (the
 * researcher's sentence in `tasks.json`; never the agent's instructions, which name paths and
 * skills), and the measurements it reports. Shown in "See tasks" (a side panel over Run on new
 * scans, so the choice in progress stays put) and on the Workflows page.
 */
import { Button } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";

export const measurementsOf = (workflow: BundledWorkflow) =>
  workflow.outputs.filter((o) => o.kind === "measurement");

/** "Measurements from Segmentation, Tibial IIOC… and Distal femur.": the tasks that report one, in task order. */
export function measuredBy(workflow: BundledWorkflow): string {
  const measuring = new Set(measurementsOf(workflow).map((o) => o.task));
  const titles = workflow.tasks
    .filter((t) => measuring.has(t.id))
    .map((t) => workflow.taskTitle(t.id));
  const last = titles.pop();
  if (!last) return "";
  return `Measurements from ${titles.length > 0 ? `${titles.join(", ")} and ${last}` : last}.`;
}

export function TaskList({ workflow }: { workflow: BundledWorkflow }) {
  return (
    <ol className="grid gap-4">
      {workflow.tasks.map((task, i) => {
        const measures = measurementsOf(workflow).filter((o) => o.task === task.id);
        return (
          <li key={task.id} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2">
            <span className="pt-px font-mono text-meta text-fg-subtle tabular-nums">{i + 1}</span>
            <div>
              <p className="font-medium">{workflow.taskTitle(task.id)}</p>
              {task.summary && <p className="text-ui text-muted-foreground">{task.summary}</p>}
              {measures.length > 0 && (
                // Names hold commas ("TV, tibial IIOC"), so each is its own chip.
                <ul aria-label="Measures" className="mt-1.5 flex flex-wrap gap-1">
                  {measures.map((o) => (
                    <li key={o.id} className="rounded-md bg-muted px-1.5 py-px text-meta">
                      {o.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** "See tasks": the workflow's tasks in a panel over the right side of the page. */
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
      aria-label={`${workflow.name} tasks`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-0 ml-auto h-dvh max-h-none w-[min(30rem,100vw)] max-w-none border-l border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-scrim open:flex open:flex-col motion-safe:open:animate-[panel-in_160ms_ease-out]"
    >
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{workflow.name}</h2>
          <p className="text-ui text-muted-foreground">
            {workflow.tasks.length} tasks, {measurementsOf(workflow).length} measurements
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
        <TaskList workflow={workflow} />
      </div>
      <footer className="border-t border-border px-5 py-3">
        {/* A new tab: leaving Run on new scans would drop the uploads under way. */}
        <Button asChild variant="link" className="text-ui">
          <Link to="/workflows" target="_blank" rel="noreferrer">
            Open in Workflows
            <ExternalLink aria-label="opens in a new tab" />
          </Link>
        </Button>
      </footer>
    </dialog>
  );
}
