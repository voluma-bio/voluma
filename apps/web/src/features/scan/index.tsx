/**
 * The scan review: one scan in 3D, dark, at `/scans/:runId`, live while its run goes and for
 * review once it ends. It replaces the run page (`/runs/:id/live`) and the old review
 * (`/runs/:runId`); both redirect here with their search kept (`task`, `agent`).
 */
import { Navigate, type RouteObject, useLocation, useParams } from "react-router";
import type { RouteHandle } from "../../shell/signed-in";
import { ScanPage } from "./scan-page";

const dark: RouteHandle = { theme: "dark" };

export const scanRoutes: RouteObject[] = [
  { path: "/scans/:runId", element: <ScanPage />, handle: dark },
  { path: "/runs/:runId/live", element: <ToScan />, handle: dark },
  { path: "/runs/:runId", element: <ToScan />, handle: dark },
];

function ToScan() {
  const { runId = "" } = useParams();
  const { search } = useLocation();
  return <Navigate replace to={`/scans/${encodeURIComponent(runId)}${search}`} />;
}
