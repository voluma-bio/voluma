/**
 * Run lane: the workflows screen (task list, scans, Run), the live run and
 * the runs list. Light theme. Owns its routes; the shell mounts them.
 */
import type { RouteObject } from "react-router";

export const runRoutes: RouteObject[] = [
  { path: "/", element: <WorkflowsPage /> },
  { path: "/runs", element: <RunsPage /> },
];

function WorkflowsPage() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Workflows</h1>
    </main>
  );
}

function RunsPage() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Runs</h1>
    </main>
  );
}
