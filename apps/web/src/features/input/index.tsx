/**
 * The input page: one input of a study in 3D at `/studies/:studyId/inputs/:inputId`, on the input's
 * newest run in that study (`?run=<runId>` opens an earlier one), live while the run goes and for
 * review once it ends. The run-keyed URLs (`/scans/:runId`, and the run page's `/runs/:runId(/live)`)
 * redirect here keeping the params this page reads (`KEPT`). The old pages' `view` and `revision`
 * mean nothing here: the screen shows every panel and the latest results.
 */
import { useQuery } from "@tanstack/react-query";
import { runQuery, studyQuery } from "@voluma/api-client/query";
import { inputHref } from "@voluma/run-view";
import { Navigate, type RouteObject, useLocation, useParams } from "react-router";
import { InputPage, Unavailable } from "./input-page";

export const inputRoutes: RouteObject[] = [
  { path: "/studies/:studyId/inputs/:inputId", element: <InputPage /> },
  { path: "/scans/:runId", element: <ToInput /> },
  { path: "/runs/:runId/live", element: <ToInput /> },
  { path: "/runs/:runId", element: <ToInput /> },
];

const KEPT = ["task", "item", "agent", "output", "trail", "centre"];

/** A run's own URL, to its input's page: `?run=` only when the run is not the input's newest in its study. */
function ToInput() {
  const { runId = "" } = useParams();
  const { search } = useLocation();
  const run = useQuery(runQuery(runId));
  const study = useQuery({ ...studyQuery(run.data?.studyId ?? ""), enabled: !!run.data });
  if (!run.data) return <Unavailable query={run} />;
  if (!study.data) return <Unavailable query={study} />;
  const { studyId, input } = run.data;
  const newest = study.data.inputs.find((i) => i.member.inputId === input.id)?.runs[0];
  const kept = new URLSearchParams(search);
  const query: Record<string, string> = {};
  for (const key of KEPT) {
    const value = kept.get(key);
    if (value !== null) query[key] = value;
  }
  if (newest?.id !== runId) query.run = runId;
  return <Navigate replace to={inputHref(studyId, input.id, query)} />;
}
