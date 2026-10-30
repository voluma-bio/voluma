/**
 * A study (`/studies/:id/*`): loads it once for every section, declares the study's pages on the
 * left strip (Dashboard, To check, Scans, Results, Details) and the Study panel, and shows the
 * section in the main area. Sections read the study through `useStudy`. A study of one has no
 * dashboard: it opens its scan. While a scan is still running the study refetches every 5 s.
 */
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@voluma/api-client";
import { studyQuery } from "@voluma/api-client/query";
import type { Me } from "@voluma/contracts/auth";
import type { StudyDetail } from "@voluma/contracts/study";
import { isLive, plural, StudyPanel } from "@voluma/run-view";
import {
  Breadcrumb,
  Button,
  ErrorState,
  LoadingState,
  ShellHeading,
  ShellLink,
  ShellPanel,
} from "@voluma/ui";
import { type BundledWorkflow, workflowById } from "@voluma/workflow/bundled";
import { ChartScatter, CircleAlert, Info, Layers, LayoutGrid, PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";
import { linkTo } from "../link";
import { scanHref } from "./study-model";

export type StudyContext = { detail: StudyDetail; workflow: BundledWorkflow; me: Me };

/** The study every section renders, with its workflow and the signed-in user. */
export const useStudy = () => useOutletContext<StudyContext>();

const SECTIONS = [
  { path: "", label: "Dashboard", icon: <LayoutGrid /> },
  { path: "check", label: "To check", icon: <CircleAlert /> },
  { path: "scans", label: "Scans", icon: <Layers /> },
  { path: "results", label: "Results", icon: <ChartScatter /> },
  { path: "details", label: "Details", icon: <Info /> },
] as const;

/** The section a path is on; the Workflow page (the dashboard's graph, expanded) is under Dashboard. */
const sectionOf = (rest: string) => SECTIONS.find((s) => s.path === rest) ?? SECTIONS[0];

export function StudyLayout() {
  const me = useOutletContext<Me>();
  const { id = "" } = useParams();
  const study = useQuery({
    ...studyQuery(id),
    refetchInterval: (query) => (query.state.data?.scans.some(isLive) ? 5000 : false),
  });

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
      <StudyChrome detail={detail} workflow={workflow} />
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
      {/* The main area is a flex column; a page must not shrink to fit it, or its graph clips. */}
      <div className="shrink-0">
        <Outlet context={{ detail, workflow, me } satisfies StudyContext} />
      </div>
    </>
  );
}

/** The study's strip pages, its Study panel and the header line's breadcrumb. */
function StudyChrome({ detail, workflow }: { detail: StudyDetail; workflow: BundledWorkflow }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const base = `/studies/${detail.study.id}`;
  const rest = pathname.slice(base.length).replace(/^\//, "");
  const here = sectionOf(rest);
  const toCheck = detail.scans.reduce((n, s) => n + s.toCheck.length, 0);
  const knees = detail.scans.some((s) => typeof s.scan.attributes.knee === "string");
  return (
    <>
      <ShellHeading>
        <Breadcrumb
          trail={[{ label: detail.study.name, to: linkTo(base) }]}
          current={rest === "workflow" ? "Workflow" : here.label}
        />
      </ShellHeading>
      <ShellPanel
        id="study"
        side="left"
        group="study"
        label="Study"
        icon={<PanelLeft />}
        shortcut="s"
        defaultOpen
      >
        <StudyPanel
          detail={detail}
          about={`${plural(detail.scans.length, knees ? "knee" : "scan")}, ${workflow.name}`}
          scanLink={(scan) => {
            const href = scanHref(scan);
            return href ? linkTo(href) : undefined;
          }}
        />
      </ShellPanel>
      {SECTIONS.map((s) => (
        <ShellLink
          key={s.path}
          id={`study-${s.path || "dashboard"}`}
          group="study-pages"
          label={s.label}
          icon={s.icon}
          count={s.path === "check" ? toCheck : undefined}
          active={here === s && (rest !== "workflow" || s.path === "")}
          go={() => navigate(s.path ? `${base}/${s.path}` : base)}
        />
      ))}
    </>
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
      {title ? (
        <ErrorState title={title} onRetry={retry}>
          {children}{" "}
          <Button asChild variant="link">
            <Link to="/">Go to Home</Link>
          </Button>
        </ErrorState>
      ) : (
        <LoadingState label={label} rows={4} />
      )}
    </div>
  );
}
