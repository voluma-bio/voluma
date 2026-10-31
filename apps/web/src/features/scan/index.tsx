/**
 * The scan review: one scan in 3D, dark, at `/scans/:runId`, live while its run goes and for
 * review once it ends. It replaces the run page (`/runs/:id/live`) and the old review
 * (`/runs/:runId`); both redirect here keeping `task`, `item` and `agent`. The old pages'
 * `view` and `revision` mean nothing here: the screen shows every panel and the latest results.
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
  const kept = new URLSearchParams(search);
  for (const key of [...kept.keys()])
    if (!["task", "item", "agent"].includes(key)) kept.delete(key);
  const query = kept.size > 0 ? `?${kept}` : "";
  return <Navigate replace to={`/scans/${encodeURIComponent(runId)}${query}`} />;
}
