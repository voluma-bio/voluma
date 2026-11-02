/**
 * Study feature: Studies (`/`), Run on new inputs (`/new`), Workflows (`/workflows`) and a study's
 * pages (`/studies/:id`: its samples, and `/compare`). Owns its routes; the shell mounts them and
 * applies the user's theme. The study's old pages (To check, Scans, Results, Details, Workflow)
 * redirect to where their content now lives; they sit under the layout, so a study of one still
 * opens its input first.
 */
import { Navigate, type RouteObject } from "react-router";
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
      { path: "check", element: <Navigate replace to="..?status=needs-you" /> },
      { path: "results", element: <Navigate replace to="../compare" /> },
      ...["inputs", "details", "workflow"].map((path) => ({
        path,
        element: <Navigate replace to=".." />,
      })),
    ],
  },
  { path: "/workflows", element: <WorkflowsPage /> },
];
