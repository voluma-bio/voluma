/**
 * Review lane: one run's review, with per-task reports and chat beside the
 * 3D view and three slice planes. Dark imaging theme, set on its root.
 * Owns its routes; the shell mounts them.
 */
import { type RouteObject, useParams } from "react-router";

export const reviewRoutes: RouteObject[] = [{ path: "/runs/:runId", element: <ReviewPage /> }];

function ReviewPage() {
  const { runId } = useParams();
  return (
    <main data-theme="dark" className="min-h-dvh p-8">
      <h1 className="text-2xl font-semibold">Review {runId}</h1>
    </main>
  );
}
