/**
 * The input page's Samples tab (`INPUT_WORD`): every study's samples in the shared tree, this run's
 * study open and its sample highlighted. `studiesQuery` refetches while a run is live, so a running
 * sample's row ("Running · 1 of 2 in") keeps up.
 */
import { useQuery } from "@tanstack/react-query";
import { studiesQuery } from "@voluma/api-client/query";
import { sampleTree } from "@voluma/run-view";
import { ErrorState, INPUT_WORD, LoadingState, SampleTree } from "@voluma/ui";
import { useMemo } from "react";
import { Link } from "react-router";

export function Samples({ studyId, inputId }: { studyId: string; inputId: string }) {
  const studies = useQuery(studiesQuery());
  const tree = useMemo(() => sampleTree(studies.data ?? []), [studies.data]);
  if (studies.isError)
    return (
      <ErrorState
        className="m-3"
        title={`Couldn't load the ${INPUT_WORD.many}`}
        onRetry={() => void studies.refetch()}
      >
        Check your connection, then try again.
      </ErrorState>
    );
  if (!studies.data)
    return <LoadingState label={`Loading the ${INPUT_WORD.many}`} rows={4} className="m-3" />;
  return (
    <SampleTree
      studies={tree}
      studyId={studyId}
      sampleId={inputId}
      renderLink={(href, props) => <Link to={href} {...props} />}
    />
  );
}
