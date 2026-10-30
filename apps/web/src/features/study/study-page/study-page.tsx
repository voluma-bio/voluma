/**
 * The study page (`/studies/:id`): a dashboard for the scans of one study, run through one
 * workflow. One header row (Home, the study's name, the tabs, Study details) over
 * Overview (groups compared per headline measurement, what needs the researcher, scan tiles),
 * To check (every open check across scans, by kind) and Scans (a table of every scan). The
 * selected tab lives in `?tab=`. A study of one has no dashboard: it opens its run.
 *
 * Every "Open in 3D" (To check rows, Needs your eye, a plot's dot) calls `openChecks`. The check
 * panel (a later lane) passes its own; until then the default opens the first stop's run review
 * at its task, and "Go through all N" stays hidden since the default can't walk a queue.
 *
 * "Add scans" waits: adding scans to an existing study isn't designed, and `/new` makes a new one.
 */
import { useQuery } from "@tanstack/react-query";
import { ApiError, getStudy } from "@voluma/api-client";
import type { StudyDetail } from "@voluma/contracts/study";
import {
  Button,
  ErrorState,
  Facts,
  LoadingState,
  Popover,
  TabList,
  TabPanel,
  Tabs,
} from "@voluma/ui";
import { formatUsd } from "@voluma/ui/run";
import { type BundledWorkflow, workflowById } from "@voluma/workflow/bundled";
import { ChevronDown } from "lucide-react";
import { useCallback } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { Overview } from "./overview";
import { ScansTable } from "./scans-table";
import { isLive, type OpenChecks, scanHref, studyCounts, studySpend } from "./study-model";
import { ToCheck } from "./to-check";

/** Where the page's loading and error states sit while there is no page to show. */
const PAGE_STATE = "mx-auto w-full max-w-2xl px-6 py-8 max-[760px]:px-3";
const homeLink = (
  <Link to="/" className="text-primary-text hover:underline">
    Go to Home
  </Link>
);

const TAB_IDS = ["overview", "check", "scans"] as const;
type TabId = (typeof TAB_IDS)[number];

export function StudyPage({ openChecks }: { openChecks?: OpenChecks }) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const tabParam = search.get("tab");
  const tab: TabId = TAB_IDS.find((t) => t === tabParam) ?? "overview";

  const study = useQuery({
    queryKey: ["study", id],
    queryFn: () => getStudy(id),
    refetchInterval: (query) => (query.state.data?.scans.some(isLive) ? 5000 : false),
  });

  const openReview = useCallback<OpenChecks>(
    (queue, start) => {
      const item = queue[start];
      if (item) navigate(`/runs/${item.runId}?task=${encodeURIComponent(item.taskId)}`);
    },
    [navigate],
  );

  const setTab = (next: TabId) =>
    setSearch(next === "overview" ? {} : { tab: next }, { preventScrollReset: true });

  if (study.isPending)
    return (
      <main className={PAGE_STATE}>
        <LoadingState label="Loading the study" rows={4} />
      </main>
    );
  // A failed background refetch keeps its data (status "error"): the page stays, with a notice.
  if (!study.data)
    return (
      <main className={PAGE_STATE}>
        {study.error instanceof ApiError && study.error.status === 404 ? (
          <ErrorState title="This study isn't here">
            It may have been removed, or it belongs to another lab. {homeLink}
          </ErrorState>
        ) : (
          <ErrorState title="Couldn't load the study" onRetry={() => void study.refetch()}>
            Check your connection, then try again. {homeLink}
          </ErrorState>
        )}
      </main>
    );

  const detail = study.data;
  const only = detail.scans.length === 1 ? detail.scans[0] : undefined;
  const onlyRun = only && scanHref(only);
  if (onlyRun) return <Navigate to={onlyRun} replace />;

  const workflow = workflowById(detail.study.workflowId);
  if (!workflow)
    return (
      <main className={PAGE_STATE}>
        <ErrorState title="Can't show this study">
          Its workflow, {detail.study.workflowId}, isn't in this version of Voluma. {homeLink}
        </ErrorState>
      </main>
    );

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
      <StudyHeader detail={detail} workflow={workflow} />
      {study.isError && (
        <p
          role="status"
          className="m-0 flex shrink-0 flex-wrap items-baseline gap-x-3 border-b border-border bg-muted px-6 py-1.5 text-meta text-muted-foreground max-[760px]:px-3"
        >
          Couldn't refresh. This is the study as of{" "}
          {new Date(study.dataUpdatedAt).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}
          .
          <Button variant="link" onClick={() => void study.refetch()}>
            Try again
          </Button>
        </p>
      )}
      <TabPanel value={tab} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[90rem] px-6 py-5 max-[760px]:px-3 max-[760px]:py-4">
          {tab === "overview" && (
            <Overview
              detail={detail}
              workflow={workflow}
              onTab={setTab}
              openChecks={openChecks ?? openReview}
            />
          )}
          {tab === "check" && (
            <ToCheck
              detail={detail}
              workflow={workflow}
              openChecks={openChecks ?? openReview}
              walkthrough={openChecks !== undefined}
            />
          )}
          {tab === "scans" && <ScansTable detail={detail} workflow={workflow} />}
        </div>
      </TabPanel>
    </Tabs>
  );
}

function StudyHeader({ detail, workflow }: { detail: StudyDetail; workflow: BundledWorkflow }) {
  const c = studyCounts(detail);
  const scansLabel = [
    `${c.done} of ${c.scans} done`,
    c.running && `${c.running} running`,
    c.waiting && `${c.waiting} waiting`,
    c.waitingForAI && `${c.waitingForAI} waiting for the AI`,
    c.notStarted && `${c.notStarted} not started`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <header className="flex shrink-0 flex-wrap items-stretch gap-x-8 border-b border-border bg-card px-6 max-[760px]:gap-x-4 max-[760px]:px-3">
      <div className="flex min-h-13 min-w-0 items-center gap-2.5">
        <Link to="/" className="text-ui text-fg-subtle hover:text-foreground">
          Home
        </Link>
        <span aria-hidden className="text-fg-subtle">
          /
        </span>
        <h1 className="truncate text-base font-semibold">{detail.study.name}</h1>
      </div>
      <TabList<TabId>
        label="Study"
        className="max-[760px]:order-last max-[760px]:-mx-3 max-[760px]:basis-[calc(100%+1.5rem)] max-[760px]:px-1"
        tabs={[
          { id: "overview", label: "Overview" },
          {
            id: "check",
            label: "To check",
            count: c.toCheck || undefined,
            alert: c.toCheck > 0,
          },
          {
            id: "scans",
            label: "Scans",
            count: `${c.done}/${c.scans}`,
            countLabel: scansLabel,
          },
        ]}
      />
      <div className="ml-auto flex items-center">
        <StudyDetails detail={detail} workflow={workflow} />
      </div>
    </header>
  );
}

function StudyDetails({ detail, workflow }: { detail: StudyDetail; workflow: BundledWorkflow }) {
  const spent = studySpend(detail);
  const budget = detail.study.budgetUsd;
  const rows: [string, string][] = [
    ["Workflow", workflow.name],
    ["Scans", String(detail.scans.length)],
    ["Spent so far", `${formatUsd(spent)}${budget === null ? "" : ` of ${formatUsd(budget)}`}`],
    [
      "Started",
      new Date(detail.study.createdAt).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    ],
  ];
  return (
    <Popover
      label="Study details"
      className="w-72"
      trigger={
        <Button variant="ghost" size="sm" className="gap-1 px-2.5">
          Study details
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      }
    >
      <Facts items={rows} />
    </Popover>
  );
}
