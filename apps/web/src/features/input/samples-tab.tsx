/**
 * Review's Samples tab: complete membership of the already-loaded current study, with a way
 * back to All studies. A failed background refresh keeps the last membership visible.
 */
import type { StudyDetail } from "@voluma/contracts/study";
import { sampleTree } from "@voluma/run-view";
import { Button, ErrorState, INPUT_WORD, LoadingState, SampleTree } from "@voluma/ui";
import { Link } from "react-router";

export function Samples({
  detail,
  inputId,
  stale,
  retry,
}: {
  detail: StudyDetail | undefined;
  inputId: string;
  stale: boolean;
  retry: () => void;
}) {
  if (!detail && stale)
    return (
      <ErrorState className="m-3" title={`Couldn't load the ${INPUT_WORD.many}`} onRetry={retry}>
        Check your connection, then try again.
      </ErrorState>
    );
  if (!detail)
    return <LoadingState label={`Loading the ${INPUT_WORD.many}`} rows={4} className="m-3" />;
  return (
    <>
      <Button asChild variant="link" className="mx-3 mt-2 self-start">
        <Link to="/">All studies</Link>
      </Button>
      {stale && (
        <p role="status" className="m-0 px-3 py-2 text-sm text-muted-foreground">
          Couldn't refresh the {INPUT_WORD.many}; showing the last study data.{" "}
          <Button variant="link" onClick={retry}>
            Try again
          </Button>
        </p>
      )}
      <SampleTree
        studies={sampleTree([detail])}
        studyId={detail.study.id}
        sampleId={inputId}
        renderLink={(href, props) => <Link to={href} {...props} />}
      />
    </>
  );
}
