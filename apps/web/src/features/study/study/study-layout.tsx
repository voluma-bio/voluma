/**
 * A study (`/studies/:id/*`): loads it once for its overview and Compare. Pages read the study
 * through `useStudy` and render the centre, with an optional right side and no second sample
 * navigator. The context row holds "Studies › <study> (› Compare)"; a study of one keeps its
 * overview. While an input is still running the study refetches every 5 s.
 */
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@voluma/api-client";
import { studyQuery } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import type { StudyDetail } from "@voluma/contracts/study";
import { Breadcrumb, Button, ErrorState, LoadingState, ShellHeading } from "@voluma/ui";
import { type BundledWorkflow, workflowById } from "@voluma/workflow/bundled";
import type { ReactNode } from "react";
import { Link, Outlet, useLocation, useOutletContext, useParams } from "react-router";
import { linkTo } from "../link";

export type StudyContext = { detail: StudyDetail; workflow: BundledWorkflow; me: Me };

/** The study every page renders, with its workflow and the signed-in user. */
export const useStudy = () => useOutletContext<StudyContext>();

export function StudyLayout() {
  const me = useOutletContext<Me>();
  const { id = "" } = useParams();
  const study = useQuery(studyQuery(id));

  if (study.isPending) return <PageState label="Loading the study" />;
  // A failed background refetch keeps its data (status "error"): the page stays, with a notice.
  if (!study.data)
    return study.error instanceof ApiError && study.error.status === 404 ? (
      <PageState title="This study isn't here">
        It may have been removed, or it belongs to another lab.
      </PageState>
    ) : (
      <PageState title="Couldn't load the study" retry={() => void study.refetch()}>
        Check your connection, then try again.
      </PageState>
    );

  const detail = study.data;
  const workflow = workflowById(detail.study.workflowId);
  if (!workflow)
    return (
      <PageState title="Can't show this study">
        Its workflow, {detail.study.workflowId}, isn't in this version of Voluma.
      </PageState>
    );

  return (
    <>
      <StudyHeading detail={detail} />
      {study.isError && (
        <p
          role="status"
          className="m-0 flex shrink-0 flex-wrap items-baseline gap-x-3 border-b border-border bg-muted px-6 py-1.5 text-sm text-muted-foreground"
        >
          Couldn't refresh the study; what you see may be out of date.
          <Button variant="link" onClick={() => void study.refetch()}>
            Try again
          </Button>
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <Outlet context={{ detail, workflow, me } satisfies StudyContext} />
      </div>
    </>
  );
}

/** The context row contains navigation only; page actions belong beside the page title. */
function StudyHeading({ detail }: { detail: StudyDetail }) {
  const { pathname } = useLocation();
  const base = `/studies/${detail.study.id}`;
  const compare = pathname.startsWith(`${base}/compare`);
  return (
    <ShellHeading>
      <Breadcrumb
        trail={[
          { label: "Studies", to: linkTo("/") },
          ...(compare ? [{ label: detail.study.name, to: linkTo(base) }] : []),
        ]}
        current={compare ? "Compare" : detail.study.name}
      />
    </ShellHeading>
  );
}

/** Where the study's loading and error states sit while there is no study to show. */
function PageState({
  label,
  title,
  retry,
  children,
}: {
  label?: string;
  title?: string;
  retry?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <ShellHeading>
        <Breadcrumb trail={[{ label: "Studies", to: linkTo("/") }]} current="Study" />
      </ShellHeading>
      <h1 className="mb-4 text-xl font-semibold">Study</h1>
      {title ? (
        <ErrorState title={title} onRetry={retry}>
          {children}{" "}
          <Button asChild variant="link">
            <Link to="/">Go to Studies</Link>
          </Button>
        </ErrorState>
      ) : (
        <LoadingState label={label} rows={4} />
      )}
    </div>
  );
}
