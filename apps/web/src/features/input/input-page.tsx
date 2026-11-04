/**
 * The input review (`/studies/:studyId/inputs/:inputId`): one input's run, live or finished, in the
 * light shell: the run's stream feeds the run store and the page is the outputs review
 * (`outputs-review.tsx`). The run (`getRun`) is polled while it goes, for what isn't an event.
 */
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ApiError } from "@voluma/api-client";
import { runQuery, studyQuery } from "@voluma/api-client/query";
import type { RunRead } from "@voluma/contracts/run";
import { RunStoreProvider } from "@voluma/run-view";
import { Button, ErrorState, INPUT_WORD, LoadingState } from "@voluma/ui";
import { useCallback, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { OutputsReview } from "./outputs-review";
import { useRunStream } from "./use-run-stream";

/** The state that stands in for the page while a read is pending, refused or failed; null once it has data. */
function Unavailable({ query }: { query: UseQueryResult<unknown> }) {
  // Laid out as the study page's own loading and not-found states.
  const page = "mx-auto w-full max-w-2xl px-6 py-8";
  if (query.isPending)
    return (
      <div className={page}>
        <LoadingState label={`Loading the ${INPUT_WORD.one}`} rows={4} />
      </div>
    );
  if (query.data) return null;
  const missing = query.error instanceof ApiError && query.error.status === 404;
  return (
    <div className={page}>
      <ErrorState
        title={
          missing ? `This ${INPUT_WORD.one} isn't here` : `Couldn't load the ${INPUT_WORD.one}`
        }
        onRetry={missing ? undefined : () => void query.refetch()}
      >
        {missing
          ? "It may have been removed, or it belongs to another lab."
          : "Check your connection, then try again."}{" "}
        <Button asChild variant="link">
          <Link to="/">Go to Studies</Link>
        </Button>
      </ErrorState>
    </div>
  );
}

/**
 * The input in a study, on its newest run, or on `?run=` (an earlier run of it). Keyed on the run:
 * nothing of one run's stream, selection or decisions carries over.
 */
export function InputPage() {
  const { studyId = "", inputId = "" } = useParams();
  const [params] = useSearchParams();
  const study = useQuery(studyQuery(studyId));
  // With `?run=` the run read needs nothing from the study: start it now (`Input` reads the same query).
  useQuery({ ...runQuery(params.get("run") ?? ""), enabled: params.has("run") });
  const unavailable = <Unavailable query={study} />;
  const entry = study.data?.inputs.find((i) => i.member.inputId === inputId);
  if (!study.data) return unavailable;
  const runId = params.get("run") ?? entry?.runs[0]?.id;
  // The run must be one of this input's in this study: a run id from elsewhere is not found.
  if (!entry || !runId || !entry.runs.some((r) => r.id === runId))
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <ErrorState title={`This ${INPUT_WORD.one} isn't here`}>
          {entry && !runId
            ? "It has no run yet."
            : "It may have been removed, or it belongs to another lab."}{" "}
          <Button asChild variant="link">
            <Link to={`/studies/${encodeURIComponent(studyId)}`}>Go to the study</Link>
          </Button>
        </ErrorState>
      </div>
    );
  return (
    <RunStoreProvider key={runId}>
      <Input runId={runId} />
    </RunStoreProvider>
  );
}

function Input({ runId }: { runId: string }) {
  const run = useQuery({
    ...runQuery(runId),
    // Queue place and state changes aren't events; the stream is the source for the rest. Also in
    // a background tab: a run waiting for keys gets them from this page (`RunAlert`). A failed read
    // (the API restarting for a deploy) keeps polling even for an ended run, so the "can't reach
    // the server" notice clears by itself; a refusal (4xx: gone, not yours) doesn't.
    refetchInterval: (q) =>
      (q.state.error instanceof ApiError && q.state.error.status < 500) ||
      (q.state.status !== "error" && q.state.data?.state.status === "ended")
        ? false
        : 3000,
    refetchIntervalInBackground: true,
  });
  if (!run.data) return <Unavailable query={run} />;
  return <InputStream run={run.data} stale={run.isError} refetchRun={() => void run.refetch()} />;
}

/** The run's stream, and its review. */
function InputStream({
  run,
  stale,
  refetchRun,
}: {
  run: RunRead;
  /** The last poll failed: what is shown may be out of date. */
  stale: boolean;
  refetchRun: () => void;
}) {
  const [reopened, setReopened] = useState(0);
  useRunStream(run.id, {
    reopened,
    going: run.state.status !== "ended",
    onClosed: refetchRun,
  });
  const reopen = useCallback(() => setReopened((n) => n + 1), []);
  return <OutputsReview run={run} stale={stale} refetchRun={refetchRun} reopen={reopen} />;
}
