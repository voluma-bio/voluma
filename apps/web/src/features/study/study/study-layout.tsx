/**
 * A study (`/studies/:id/*`): loads it once for its two pages (the scans, and Compare), puts
 * "Studies › <study> (› Compare)" and "Next sample that needs you" in the header line, and the
 * scan tree on the left side (this study open, the lab's other studies below). Pages read the
 * study through `useStudy` and render the centre, and a right side if they have one, beside the
 * tree. A study of one has no study page: it opens its scan. While a scan is still running the
 * study refetches every 5 s.
 */
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@voluma/api-client";
import { studiesQuery, studyQuery } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import type { StudyDetail } from "@voluma/contracts/study";
import { sampleTree } from "@voluma/run-view";
import {
  Breadcrumb,
  Button,
  ErrorState,
  INPUT_WORD,
  LoadingState,
  SampleTree,
  ShellHeading,
  SidePanel,
} from "@voluma/ui";
import { type BundledWorkflow, workflowById } from "@voluma/workflow/bundled";
import { ChevronRight, ListTree } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, Outlet, useLocation, useOutletContext, useParams } from "react-router";
import { linkTo } from "../link";
import { byMostToCheck, placeOf, reviewHref, scanHref } from "./study-model";

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
  const only = detail.scans.length === 1 ? detail.scans[0] : undefined;
  const onlyRun = only && scanHref(only);
  if (onlyRun) return <Navigate to={onlyRun} replace />;

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
        <SamplesSide studyId={detail.study.id} />
        <Outlet context={{ detail, workflow, me } satisfies StudyContext} />
      </div>
    </>
  );
}

/** The header line: where you are, and the next scan that needs you. */
function StudyHeading({ detail }: { detail: StudyDetail }) {
  const { pathname } = useLocation();
  const base = `/studies/${detail.study.id}`;
  const compare = pathname.startsWith(`${base}/compare`);
  const [next] = byMostToCheck(
    detail.scans.filter((s) => placeOf(s, detail.study.example) === "needs-you"),
  );
  const nextHref = next && reviewHref(next);
  return (
    <ShellHeading>
      <Breadcrumb
        trail={[
          { label: "Studies", to: linkTo("/") },
          ...(compare ? [{ label: detail.study.name, to: linkTo(base) }] : []),
        ]}
        current={compare ? "Compare" : detail.study.name}
      />
      {nextHref && (
        <Button asChild variant="secondary" size="sm" className="ml-auto">
          <Link to={nextHref}>
            Next {INPUT_WORD.one} that needs you:
            <span className="font-mono font-semibold">{next.scan.subject}</span>
            <ChevronRight aria-hidden />
          </Link>
        </Button>
      )}
    </ShellHeading>
  );
}

/** The left side: the scan tree, from the lab's study list. */
function SamplesSide({ studyId }: { studyId: string }) {
  const studies = useQuery(studiesQuery());
  return (
    <SidePanel side="left" title={INPUT_WORD.Many} icon={<ListTree />}>
      {studies.data ? (
        <SampleTree
          studies={sampleTree(studies.data)}
          studyId={studyId}
          renderLink={(href, props) => <Link to={href} {...props} />}
        />
      ) : studies.isError ? (
        <p className="m-0 px-4 py-3 text-sm text-muted-foreground">
          Couldn't load the {INPUT_WORD.many}.
        </p>
      ) : (
        <LoadingState label={`Loading the ${INPUT_WORD.many}`} rows={4} className="px-3 py-2" />
      )}
    </SidePanel>
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
