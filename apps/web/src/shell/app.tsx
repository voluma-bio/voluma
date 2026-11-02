/**
 * Router shell. Each feature owns its routes; the shell only
 * collects them, so a lane never edits this file to add a screen. Every
 * feature route sits behind the sign-in gate. Shared components are
 * shown in Storybook (apps/storybook), not in the app.
 */
import { Button } from "@voluma/ui";
import { createBrowserRouter, Link, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import { scanRoutes } from "../features/scan";
import { studyRoutes } from "../features/study";
import { SignedIn } from "./signed-in";

const router = createBrowserRouter([
  {
    element: <SignedIn />,
    children: [
      ...studyRoutes,
      ...scanRoutes,
      // The old Settings page: the theme and account now live in the rail's Settings.
      { path: "settings", element: <Navigate to="/" replace state={{ openSettings: true }} /> },
      { path: "*", element: <NotFound /> },
    ],
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
