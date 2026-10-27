/**
 * Review lane: one run's review, with per-task reports and chat beside the
 * 3D view and three slice planes. Light Review chrome; no simulator is mounted.
 * Owns its routes; the shell mounts them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ViewerWorkspace } from "@voluma/viewer";
import { Link, type RouteObject, useParams, useSearchParams } from "react-router";
import { ReviewWorkspace } from "./report/ReviewWorkspace";

export const reviewRoutes: RouteObject[] = [{ path: "/runs/:runId", element: <ReviewPage /> }];
const queryClient = new QueryClient();

function ReviewPage() {
  const { runId } = useParams();
  const [search, setSearch] = useSearchParams();
  return (
    <QueryClientProvider client={queryClient}>
      <ReviewWorkspace
        runId={runId ?? "local"}
        taskId={search.get("task") ?? undefined}
        revisionId={search.get("revision") ?? undefined}
        navigate={(selection) => {
          const next = new URLSearchParams();
          if (selection.task) next.set("task", selection.task);
          if (selection.revision) next.set("revision", selection.revision);
          setSearch(next);
        }}
        backLink={<Link to="/runs">Back to runs</Link>}
        viewer={(selected, display) => <ViewerWorkspace selected={selected} display={display} />}
        onResult={() => {}}
      />
    </QueryClientProvider>
  );
}
