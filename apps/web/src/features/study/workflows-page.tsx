/**
 * Workflows (`/workflows`, in global navigation): the workflows a study can use, each with its
 * measurements, read from the bundle. No versions or editing yet.
 */
import { Box, Count, PageHead } from "@voluma/ui";
import { workflowById } from "@voluma/workflow/bundled";
import { MeasurementList, measurementsOf } from "./workflow-measurements";

const WORKFLOWS = [workflowById("mouse-oa")].filter((w) => w !== undefined);

export function WorkflowsPage() {
  return (
    <div className="shrink-0">
      <PageHead title="Workflows" count={<Count>{WORKFLOWS.length}</Count>} />
      {WORKFLOWS.map((w) => (
        <Box
          key={w.id}
          title={w.name}
          tools={
            <span className="text-sm text-muted-foreground">
              {measurementsOf(w).length} measurements
            </span>
          }
          className="border-b border-border"
        >
          <div className="grid max-w-3xl gap-4 px-6 py-4">
            <p className="m-0 text-muted-foreground">{w.description}</p>
            <MeasurementList workflow={w} />
          </div>
        </Box>
      ))}
    </div>
  );
}
