/**
 * Router shell. Each feature owns its routes and its theme; the shell only
 * collects them, so the run and review lanes never edit this file to add a
 * screen. Navigation goes Workflows → Runs → one run's review.
 */
import { createBrowserRouter, Link, RouterProvider } from "react-router";
import { DevUiPage } from "../dev-ui/dev-ui-page";
import { reviewRoutes } from "../features/review";
import { runRoutes } from "../features/run";

const router = createBrowserRouter([
  ...runRoutes,
  ...reviewRoutes,
  { path: "/dev/ui", element: <DevUiPage /> },
  { path: "*", element: <NotFound /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}

function NotFound() {
  return (
    <main className="grid min-h-dvh place-content-center gap-2 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link to="/" className="text-accent-text hover:underline">
        Go to workflows
      </Link>
    </main>
  );
}
