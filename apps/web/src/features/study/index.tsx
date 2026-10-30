/**
 * Study feature: Home (`/`), Run on new scans (`/new`), Workflows (`/workflows`) and a study's
 * dashboard (`/studies/:id`). Light theme. Owns its routes; the
 * shell mounts them.
 */
import type { RouteObject } from "react-router";
import { HomePage } from "./home-page";
import { NewPage } from "./new-page";
import { StudyPage } from "./study-page/study-page";
import { WorkflowsPage } from "./workflows-page";

export const studyRoutes: RouteObject[] = [
  { path: "/", element: <HomePage /> },
  { path: "/new", element: <NewPage /> },
  { path: "/studies/:id", element: <StudyPage /> },
  { path: "/workflows", element: <WorkflowsPage /> },
];
