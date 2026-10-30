/**
 * Review lane: a run's results, task by task, beside the task's own analysis grid.
 * Light Review chrome. Owns its routes; the shell mounts them.
 */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ApiError } from "@voluma/api-client";
import { reviewRunQuery, runQuery } from "@voluma/api-client/query";
import { Button, EmptyState, ErrorState, LoadingState } from "@voluma/ui";
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
    ...runQuery(runId),
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
      void queryClient.invalidateQueries({ queryKey: reviewRunQuery(runId).queryKey });
    lastStatus.current = runStatus;
  }, [runStatus, runId]);
  const review = useQuery({
    ...reviewRunQuery(runId),
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
  if (!review.data) {
    const status = review.error instanceof ApiError ? review.error.status : undefined;
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-8 max-[760px]:px-3">
        {review.isPending ? (
          <LoadingState label="Loading the results" rows={4} />
        ) : status === 409 ? (
          <EmptyState title="No plan yet">Results appear here once the run starts.</EmptyState>
        ) : status === 404 ? (
          <ErrorState title="This run isn't here">
            It may have been removed, or you can't open it.{" "}
            <Link to="/" className="text-primary-text hover:underline">
              Go to Home
            </Link>
          </ErrorState>
        ) : (
          <ErrorState title="Couldn't load the results" onRetry={() => void review.refetch()}>
            Check your connection, then try again.
          </ErrorState>
        )}
      </div>
    );
  }
  // Loaded data stays on screen when a background refetch fails.
  const notice = review.isError ? (
    <>
      Couldn't refresh the results. Decisions are off until they refresh.
      <Button disabled={review.isFetching} onClick={() => void review.refetch()}>
        {review.isFetching ? "Trying again…" : "Try again"}
      </Button>
    </>
  ) : live ? (
    "This run is still going. Results fill in as tasks report; you can accept checks and mark it reviewed once it completes."
  ) : undefined;
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
        queryClient.invalidateQueries(
          { queryKey: reviewRunQuery(runId).queryKey },
          { throwOnError: true },
        )
      }
    />
  );
}
