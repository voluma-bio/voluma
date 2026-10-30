/**
 * Workflows (`/workflows`, the top bar's quiet link): the workflows a study can use, each with
 * its tasks and measurements, read from the bundle. No versions or editing yet.
 */
import { catalog } from "@voluma/workflow/bundled";
import { measurementsOf, TaskList } from "./workflow-tasks";

const WORKFLOWS = [catalog["mouse-oa"]];

export function WorkflowsPage() {
  return (
    <div className="mx-auto grid w-full max-w-[760px] content-start gap-6 px-6 pt-7 pb-16 max-[760px]:px-4">
      <h1 className="text-2xl font-semibold">Workflows</h1>
      {WORKFLOWS.map((w) => (
        <section
          key={w.id}
          aria-labelledby={`wf-${w.id}`}
          className="grid gap-4 rounded-xl border border-border bg-card px-5 py-4"
        >
          <div>
            <h2 id={`wf-${w.id}`} className="text-lg font-semibold">
              {w.name}
            </h2>
            <p className="text-muted-foreground">{w.description}</p>
            <p className="text-ui text-fg-subtle">
              {w.tasks.length} tasks, {measurementsOf(w).length} measurements
            </p>
          </div>
          <TaskList workflow={w} />
        </section>
      ))}
    </div>
  );
}
