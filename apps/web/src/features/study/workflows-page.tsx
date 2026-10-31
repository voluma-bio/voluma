/**
 * Workflows (`/workflows`, on the left strip): the workflows a study can use, each with its tasks
 * and measurements, read from the bundle. No versions or editing yet.
 */
import { Box, Breadcrumb, Count, PageHead, ShellHeading } from "@voluma/ui";
import { catalog } from "@voluma/workflow/bundled";
import { measurementsOf, TaskList } from "./workflow-tasks";

const WORKFLOWS = [catalog["mouse-oa"]];

export function WorkflowsPage() {
  return (
    <div className="shrink-0">
      <ShellHeading>
        <Breadcrumb current="Workflows" />
      </ShellHeading>
      <PageHead title="Workflows" count={<Count>{WORKFLOWS.length}</Count>} />
      {WORKFLOWS.map((w) => (
        <Box
          key={w.id}
          title={w.name}
          tools={
            <span className="text-sm text-muted-foreground">
              {w.tasks.length} tasks, {measurementsOf(w).length} measurements
            </span>
          }
          className="border-b border-border"
        >
          <div className="grid max-w-3xl gap-4 px-6 py-4">
            <p className="m-0 text-muted-foreground">{w.description}</p>
            <TaskList workflow={w} />
          </div>
        </Box>
      ))}
    </div>
  );
}
