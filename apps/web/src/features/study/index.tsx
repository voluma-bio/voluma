/**
 * Study feature: Studies (`/`), Run on new scans (`/new`), Workflows (`/workflows`) and a study's
 * pages (`/studies/:id`: its samples, and `/compare`). Owns its routes; the shell mounts them and
 * applies the user's theme.
 */
import type { RouteObject } from "react-router";
import { NewPage } from "./new-page";
import { StudiesPage } from "./studies-page";
import { ComparePage } from "./study/compare-page";
import { StudyLayout } from "./study/study-layout";
import { StudyPage } from "./study/study-page";
import { WorkflowsPage } from "./workflows-page";

export const studyRoutes: RouteObject[] = [
  { path: "/", element: <StudiesPage /> },
  { path: "/new", element: <NewPage /> },
  {
    path: "/studies/:id",
    element: <StudyLayout />,
    children: [
      { index: true, element: <StudyPage /> },
      { path: "compare", element: <ComparePage /> },
    ],
  },
  { path: "/workflows", element: <WorkflowsPage /> },
];
