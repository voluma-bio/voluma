/**
 * Review lane: a run's results, task by task, beside the task's own analysis grid.
 * Light Review chrome. Owns its routes; the shell mounts them.
 */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ApiError, getReviewRun, getRun } from "@voluma/api-client";
import { useEffect, useRef } from "react";
import { Link, type RouteObject, useParams, useSearchParams } from "react-router";
import { preparing } from "./report/model";
import { ReviewWorkspace } from "./report/ReviewWorkspace";

const queryClient = new QueryClient();
export const reviewRoutes: RouteObject[] = [{ path: "/runs/:runId", element: <ReviewPage /> }];

function ReviewPage() {
  const { runId = "" } = useParams();
  // A route change drops the previous run's state instead of showing it under another run.
  return (
    <QueryClientProvider client={queryClient}>
      <RunReview key={runId} runId={runId} />
    </QueryClientProvider>
  );
}

function RunReview({ runId }: { runId: string }) {
  const [search, setSearch] = useSearchParams();
  const execution = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRun(runId),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && data.state.status !== "ended" ? 3000 : false;
    },
  });
  const runStatus = execution.data?.state.status;
  const endedAt =
    execution.data?.state.status === "ended" ? Date.parse(execution.data.state.endedAt) : undefined;
  const live = runStatus !== undefined && runStatus !== "ended";
  // The review payload carries no run status, so the run ending is the cue for one last fetch
  // (the polled snapshot is up to 5 s old and has no review summary yet).
  const lastStatus = useRef(runStatus);
  useEffect(() => {
    if (lastStatus.current !== undefined && lastStatus.current !== "ended" && runStatus === "ended")
      void queryClient.invalidateQueries({ queryKey: ["review-run", runId] });
    lastStatus.current = runStatus;
  }, [runStatus, runId]);
  const review = useQuery({
    queryKey: ["review-run", runId],
    queryFn: () => getReviewRun(runId),
    // Only a server error may pass on retry; a 404, a 409 or data the contract rejects won't.
    retry: (count, cause) => cause instanceof ApiError && cause.status >= 500 && count < 2,
    // A run with no plan yet gets one once the runner starts it; a live run's results fill in
    // as tasks report, and its images as they are converted, which may finish after it ends
    // (for ten minutes after: a run from before conversion existed never gets them).
    // The effect above makes the final fetch when the run ends.
    refetchInterval: (query) => {
      const cause = query.state.error;
      const data = query.state.data;
      return (cause instanceof ApiError && cause.status === 409) ||
        live ||
        (data && preparing(data) && endedAt !== undefined && Date.now() - endedAt < 10 * 60_000)
        ? 5000
        : false;
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
    ) : review.data ? undefined : review.isPending ? (
      "Loading results…"
    ) : status === 409 ? (
      "This run has no plan yet. Results appear here once it starts."
    ) : status === 404 ? (
      "This run is unavailable or you do not have access to it."
    ) : (
      "Could not load this run's results."
    );
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
      onRefresh={() =>
        queryClient.invalidateQueries({ queryKey: ["review-run", runId] }, { throwOnError: true })
      }
    />
  );
}
