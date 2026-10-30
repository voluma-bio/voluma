/**
 * Review lane: authorized R2 scan intake beside the result workspace. Opening images
 * does not create an analysis run or populate reports. Light Review chrome.
 * Owns its routes; the shell mounts them.
 */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  ApiError,
  downloadFile,
  getInputDownload,
  getReviewRun,
  getRun,
  listInputs,
  reviewFileUrl,
} from "@voluma/api-client";
import { type DicomArchive, openDicomZip, ViewerWorkspace } from "@voluma/viewer";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, type RouteObject, useParams, useSearchParams } from "react-router";
import { ReviewWorkspace } from "./report/ReviewWorkspace";

// three.js and the zarr reader load only with the grid page.
const GridPage = lazy(() => import("./grid-page").then((m) => ({ default: m.GridPage })));
const queryClient = new QueryClient();
export const reviewRoutes: RouteObject[] = [
  { path: "/runs/:runId", element: <ReviewPage /> },
  {
    path: "/runs/:runId/grid",
    element: (
      <QueryClientProvider client={queryClient}>
        <Suspense>
          <GridPage />
        </Suspense>
      </QueryClientProvider>
    ),
  },
];

function ReviewPage() {
  const { runId } = useParams();
  // A route change releases the scan instead of showing it under a different run.
  return (
    <QueryClientProvider client={queryClient}>
      <ScanReview key={runId} runId={runId ?? "local"} />
    </QueryClientProvider>
  );
}

function ScanReview({ runId }: { runId: string }) {
  const [search, setSearch] = useSearchParams();
  const fileUrl = useCallback((sha256: string) => reviewFileUrl(runId, sha256), [runId]);
  const execution = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRun(runId),
    enabled: runId !== "local",
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && data.state.status !== "ended" ? 3000 : false;
    },
  });
  const runStatus = execution.data?.state.status;
  const live = runStatus !== undefined && runStatus !== "ended";
  // The review payload carries no run status, so the run ending is the cue for one last fetch
  // (the polled snapshot is up to 5 s old and has no review summary yet).
  const lastStatus = useRef(runStatus);
  useEffect(() => {
    if (lastStatus.current !== undefined && lastStatus.current !== "ended" && runStatus === "ended")
      void queryClient.invalidateQueries({ queryKey: ["review-run", runId] });
    lastStatus.current = runStatus;
  }, [runStatus, runId]);
  // `/runs/local` is the reference scan alone: no run, so no results.
  const review = useQuery({
    queryKey: ["review-run", runId],
    queryFn: () => getReviewRun(runId),
    enabled: runId !== "local",
    // Only a server error may pass on retry; a 404, a 409 or data the contract rejects won't.
    retry: (count, cause) => cause instanceof ApiError && cause.status >= 500 && count < 2,
    // A run with no plan yet gets one once the runner starts it; a live run's results fill in
    // as tasks report. The effect above makes the final fetch when the run ends.
    refetchInterval: (query) => {
      const cause = query.state.error;
      return (cause instanceof ApiError && cause.status === 409) || live ? 5000 : false;
    },
  });
  const status = review.error instanceof ApiError ? review.error.status : undefined;
  // Loaded data stays on screen when a background refetch fails.
  const notice =
    review.data && review.isError ? (
      <>
        Could not refresh results. Decisions are disabled until results refresh.
        <button
          type="button"
          className="button"
          disabled={review.isFetching}
          onClick={() => void review.refetch()}
        >
          {review.isFetching ? "Retrying…" : "Retry"}
        </button>
      </>
    ) : review.data && live ? (
      "This run is still going. Results fill in as tasks report; you can accept checks and mark it reviewed once it completes."
    ) : runId === "local" || review.data ? undefined : review.isPending ? (
      "Loading results…"
    ) : status === 409 ? (
      "This run has no plan yet. Results appear here once it starts."
    ) : status === 404 ? (
      "This run is unavailable or you do not have access to it."
    ) : (
      "Could not load this run's results."
    );
  const [archive, setArchive] = useState<DicomArchive>();
  const [selectedSeries, setSelectedSeries] = useState("");
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  function close() {
    controller.current?.abort();
    controller.current = null;
    setArchive(undefined);
    setSelectedSeries("");
    setProgress(undefined);
    setError(undefined);
  }

  async function open() {
    close();
    const request = new AbortController();
    controller.current = request;
    setProgress("Looking up scan…");
    try {
      const inputId =
        runId === "local"
          ? (await listInputs()).find((item) => item.source === "reference")?.id
          : (await getRun(runId)).input.id;
      request.signal.throwIfAborted();
      if (!inputId) throw new Error("No reference scan is available in this workspace.");
      const descriptor = await getInputDownload(inputId, request.signal);
      const file = await downloadFile(descriptor, {
        acceptedMediaTypes: ["application/zip"],
        // Compressed transfer limit; the importer separately caps expanded DICOM data.
        maxBytes: 2 * 1024 ** 3,
        signal: request.signal,
        onProgress: (received, total) =>
          setProgress(
            `Downloading scan ${Math.floor((received / total) * 100)}% (${(received / 1024 ** 2).toFixed(1)} / ${(total / 1024 ** 2).toFixed(1)} MiB)…`,
          ),
      });
      request.signal.throwIfAborted();
      setProgress("Reading ZIP…");
      const loaded = await openDicomZip(file, request.signal, (done, total) =>
        setProgress(`Reading files ${done} / ${total}…`),
      );
      if (request.signal.aborted) return;
      setArchive(loaded);
      // Never guess which acquisition the researcher intends when there are several.
      if (loaded.series.length === 1) setSelectedSeries(loaded.series[0]?.id ?? "");
    } catch (cause) {
      if (!request.signal.aborted) {
        setError(
          cause instanceof ApiError
            ? cause.status === 503
              ? "Scan storage is not configured. Contact the workspace administrator."
              : cause.status === 404
                ? "This scan is unavailable or you do not have access to it."
                : "Could not download the scan. Try opening it again."
            : cause instanceof Error
              ? cause.message
              : "Could not open this scan.",
        );
      }
    } finally {
      if (!request.signal.aborted) setProgress(undefined);
    }
  }

  const series = archive?.series.find((item) => item.id === selectedSeries);
  return (
    <ReviewWorkspace
      runId={runId}
      run={review.data}
      canReview={execution.data?.example === false && !review.isError}
      notice={notice}
      taskId={search.get("task") ?? undefined}
      revisionId={search.get("revision") ?? undefined}
      navigate={(selection) => {
        const next = new URLSearchParams();
        if (selection.task) next.set("task", selection.task);
        if (selection.revision) next.set("revision", selection.revision);
        setSearch(next);
      }}
      backLink={<Link to="/">Home</Link>}
      viewer={(selected, display, revision, focus) => (
        <ViewerWorkspace
          series={series}
          selected={selected}
          display={display}
          revision={revision}
          focus={focus}
          fileUrl={fileUrl}
        >
          <div className="dicom-intake">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="button" onClick={() => void open()}>
                {runId === "local" ? "Open reference scan" : "Open run scan"}
              </button>
              {archive && (
                <label className="revision-select">
                  Series
                  <select
                    aria-label="DICOM series"
                    value={selectedSeries}
                    onChange={(event) => setSelectedSeries(event.target.value)}
                  >
                    <option value="" disabled>
                      Choose a series
                    </option>
                    {archive.series.map((item, i) => (
                      <option key={item.id} value={item.id}>
                        {i + 1}: {item.modality} · {item.columns} × {item.rows} ·{" "}
                        {item.slices.length} slices
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(archive || progress) && (
                <button type="button" className="button" onClick={close}>
                  {progress ? "Cancel import" : "Close scan"}
                </button>
              )}
            </div>
            {progress && (
              <p className="text-sm mt-2" role="status">
                {progress}
              </p>
            )}
            {archive && !selectedSeries && (
              <p className="text-sm mt-2" role="status">
                Choose a series to view. Series are not combined.
              </p>
            )}
            {!!archive?.ignoredFiles && (
              <p className="text-xs text-muted-foreground mt-2">
                Skipped {archive.ignoredFiles} non-image files.
              </p>
            )}
            {error && (
              <p className="error-message mt-2" role="alert">
                {error}
              </p>
            )}
          </div>
        </ViewerWorkspace>
      )}
      onRefresh={() =>
        queryClient.invalidateQueries({ queryKey: ["review-run", runId] }, { throwOnError: true })
      }
    />
  );
}
