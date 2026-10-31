/**
 * Study feature: Home (`/`), Run on new scans (`/new`), Workflows (`/workflows`) and a study's
 * pages (`/studies/:id`: Dashboard, To check, Scans, Results, Details, and the workflow
 * expanded). Light theme. Owns its routes; the shell mounts them.
 */
import type { RouteObject } from "react-router";
import { HomePage } from "./home-page";
import { NewPage } from "./new-page";
import { Dashboard } from "./study/dashboard";
import { DetailsPage } from "./study/details";
import { ResultsPage } from "./study/results";
import { ScansPage } from "./study/scans";
import { StudyLayout } from "./study/study-layout";
import { ToCheckPage } from "./study/to-check";
import { WorkflowPage } from "./study/workflow-page";
import { WorkflowsPage } from "./workflows-page";

export const studyRoutes: RouteObject[] = [
  { path: "/", element: <HomePage /> },
  { path: "/new", element: <NewPage /> },
  {
    path: "/studies/:id",
    element: <StudyLayout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "check", element: <ToCheckPage /> },
      { path: "scans", element: <ScansPage /> },
      { path: "results", element: <ResultsPage /> },
      { path: "details", element: <DetailsPage /> },
      { path: "workflow", element: <WorkflowPage /> },
    ],
  },
  { path: "/workflows", element: <WorkflowsPage /> },
];
