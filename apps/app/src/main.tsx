/** Composition root: the app owns routing and service selection, not review logic. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  redirect,
} from "@tanstack/react-router";
import { createDemoService, ReviewWorkspace } from "@voluma/review";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";

const queryClient = new QueryClient();
const demo = createDemoService();
const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <main className="load-state">
      <h1>Page not found</h1>
      <Link to="/runs" className="button">
        Back to runs
      </Link>
    </main>
  ),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({
      to: "/runs/$runId/review",
      params: { runId: "oa6-1rk" },
      search: { task: "femur" },
    });
  },
});
const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  component: () => (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold text-primary">Runs</h1>
      <p className="my-4 text-muted-foreground">
        Demo navigation only. Upload and execution belong to the Run lane.
      </p>
      <Link
        to="/runs/$runId/review"
        params={{ runId: "oa6-1rk" }}
        search={{ task: "femur" }}
        className="flex justify-between rounded-lg border border-border bg-card p-5"
      >
        <span>
          <strong>OA6-1RK</strong>
          <span className="block text-sm text-muted-foreground mt-1">
            Mouse OA knee · v1.0 · Demo fixture
          </span>
        </span>
        <span className="text-primary">Open review →</span>
      </Link>
    </main>
  ),
});
const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId/review",
  validateSearch: (
    search: Record<string, unknown>,
  ): { task?: string; revision?: string } => ({
    task: typeof search.task === "string" ? search.task : undefined,
    revision: typeof search.revision === "string" ? search.revision : undefined,
  }),
  component: ReviewRoute,
});
function ReviewRoute() {
  const { runId } = reviewRoute.useParams();
  const { task, revision } = reviewRoute.useSearch();
  const navigate = reviewRoute.useNavigate();
  return (
    <ReviewWorkspace
      runId={runId}
      taskId={task}
      revisionId={revision}
      navigate={(selection) => void navigate({ search: selection })}
      backLink={<Link to="/runs">Back to runs</Link>}
      service={demo.service}
      demoControls={demo.controls}
    />
  );
}
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, runsRoute, reviewRoute]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
