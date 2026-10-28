/**
 * Router shell. Each feature owns its routes and its theme; the shell only
 * collects them, so the run and review lanes never edit this file to add a
 * screen. Every feature route sits behind the sign-in gate; /dev/ui does not,
 * because it is a dev page. Navigation goes Workflows → Runs → one run's review.
 */
import { createBrowserRouter, Link } from "react-router";
import { RouterProvider } from "react-router/dom";
import { DevUiPage } from "../dev-ui/dev-ui-page";
import { reviewRoutes } from "../features/review";
import { runRoutes } from "../features/run";
import { SignedIn } from "./signed-in";

const router = createBrowserRouter([
  { path: "/dev/ui", element: <DevUiPage /> },
  {
    element: <SignedIn />,
    children: [...runRoutes, ...reviewRoutes, { path: "*", element: <NotFound /> }],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}

function NotFound() {
  return (
    <main className="grid min-h-dvh place-content-center gap-2 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link to="/" className="text-primary-text hover:underline">
        Go to workflows
      </Link>
    </main>
  );
}
