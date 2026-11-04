/**
 * The input page: one input of a study in 3D at `/studies/:studyId/inputs/:inputId`, on the input's
 * newest run in that study (`?run=<runId>` opens an earlier one), live while the run goes and for
 * review once it ends.
 */
import type { RouteObject } from "react-router";
import { InputPage } from "./input-page";

export const inputRoutes: RouteObject[] = [
  { path: "/studies/:studyId/inputs/:inputId", element: <InputPage /> },
];
