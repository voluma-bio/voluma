/**
 * Router shell. Each feature owns its routes and its theme; the shell only
 * collects them, so the run and review lanes never edit this file to add a
 * screen. Every feature route sits behind the sign-in gate. Shared components are
 * shown in Storybook (apps/storybook), not in the app.
 */
import { Button } from "@voluma/ui";
import { createBrowserRouter, Link } from "react-router";
import { RouterProvider } from "react-router/dom";
import { reviewRoutes } from "../features/review";
import { runRoutes } from "../features/run";
import { studyRoutes } from "../features/study";
import { SignedIn } from "./signed-in";

const router = createBrowserRouter([
  {
    element: <SignedIn />,
    children: [...studyRoutes, ...runRoutes, ...reviewRoutes, { path: "*", element: <NotFound /> }],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}

function NotFound() {
  return (
    <div className="grid flex-1 place-content-center gap-2 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Button asChild variant="link" className="justify-self-center">
        <Link to="/">Go to Home</Link>
      </Button>
    </div>
  );
}
