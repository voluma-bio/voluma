/**
 * Review lane: authorized R2 scan intake beside the result workspace. Opening images
 * does not create an analysis run or populate reports. Light Review chrome.
 * Owns its routes; the shell mounts them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, downloadFile, getInputDownload, getRun, listInputs } from "@voluma/api-client";
import { type DicomArchive, openDicomZip, ViewerWorkspace } from "@voluma/viewer";
import { useEffect, useRef, useState } from "react";
import { Link, type RouteObject, useParams, useSearchParams } from "react-router";
import { ReviewWorkspace } from "./report/ReviewWorkspace";

export const reviewRoutes: RouteObject[] = [{ path: "/runs/:runId", element: <ReviewPage /> }];
const queryClient = new QueryClient();

function ReviewPage() {
  const { runId } = useParams();
  // A route change releases the scan instead of showing it under a different run.
  return <ScanReview key={runId} runId={runId ?? "local"} />;
}

function ScanReview({ runId }: { runId: string }) {
  const [search, setSearch] = useSearchParams();
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
    <QueryClientProvider client={queryClient}>
      <ReviewWorkspace
        runId={runId}
        taskId={search.get("task") ?? undefined}
        revisionId={search.get("revision") ?? undefined}
        navigate={(selection) => {
          const next = new URLSearchParams();
          if (selection.task) next.set("task", selection.task);
          if (selection.revision) next.set("revision", selection.revision);
          setSearch(next);
        }}
        backLink={<Link to="/runs">Back to runs</Link>}
        intake={
          <div className="dicom-intake">
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="button primary" onClick={() => void open()}>
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
        }
        viewer={(selected, display) => (
          <ViewerWorkspace selected={selected} display={display} series={series} />
        )}
        onResult={() => {}}
      />
    </QueryClientProvider>
  );
}
