/**
 * Run lane: the workflows screen (outputs checklist, scans, Run), the live run and
 * the runs list. Light theme. Owns its routes; the shell mounts them.
 */
import type { RouteObject } from "react-router";
import { RunLayout } from "./run-layout";
import { RunPage } from "./run-page";
import { RunsPage } from "./runs-page";
import { StartPage } from "./start-page";

export const runRoutes: RouteObject[] = [
  {
    element: <RunLayout />,
    children: [
      { path: "/", element: <StartPage /> },
      { path: "/runs", element: <RunsPage /> },
      { path: "/runs/:id", element: <RunPage /> },
    ],
  },
];
