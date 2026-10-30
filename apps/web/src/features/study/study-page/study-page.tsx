/**
 * The study page (`/studies/:id`): a dashboard for the scans of one study, run through one
 * workflow. One header row (Home, the study's name, the tabs, Study details) over
 * Overview (groups compared per headline measurement, what needs the researcher, scan tiles),
 * To check (every open check across scans, by kind) and Scans (a table of every scan). The
 * selected tab lives in `?tab=`. A study of one has no dashboard: it opens its run.
 *
 * Every "Open in 3D" (To check rows, Needs your eye, a plot's dot) calls `openChecks`, which opens
 * the check panel over the page on that queue. "Looks right" in the panel refreshes the study,
 * as the row's own button does, so the item leaves To check.
 *
 * "Add scans" waits: adding scans to an existing study isn't designed, and `/new` makes a new one.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, getStudy } from "@voluma/api-client";
import { CheckPanel } from "@voluma/check-panel";
import type { StudyDetail } from "@voluma/contracts/study";
import { Button, Tabs } from "@voluma/ui";
import { formatUsd } from "@voluma/ui/run";
import { type BundledWorkflow, workflowById } from "@voluma/workflow/bundled";
import { ChevronDown } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { Overview } from "./overview";
import { ScansTable } from "./scans-table";
import {
  type CheckStop,
  isLive,
  type OpenChecks,
  scanHref,
  studyCounts,
  studySpend,
} from "./study-model";
import { ToCheck } from "./to-check";

const TAB_IDS = ["overview", "check", "scans"] as const;
type TabId = (typeof TAB_IDS)[number];
const PANEL_ID = "study-panel";

export function StudyPage() {
  const { id = "" } = useParams();
  const client = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const tabParam = search.get("tab");
  const tab: TabId = TAB_IDS.find((t) => t === tabParam) ?? "overview";

  const study = useQuery({
    queryKey: ["study", id],
    queryFn: () => getStudy(id),
    refetchInterval: (query) => (query.state.data?.scans.some(isLive) ? 5000 : false),
  });

  const [panel, setPanel] = useState<{ queue: CheckStop[]; start: number }>();
  const openChecks: OpenChecks = (queue, start) => setPanel({ queue, start });

  const setTab = (next: TabId) =>
    setSearch(next === "overview" ? {} : { tab: next }, { preventScrollReset: true });

  if (study.isPending) return <Loading />;
  // A failed background refetch keeps its data (status "error"): the page stays, with a notice.
  if (!study.data) return <LoadError error={study.error} retry={() => void study.refetch()} />;

  const detail = study.data;
  const only = detail.scans.length === 1 ? detail.scans[0] : undefined;
  const onlyRun = only && scanHref(only);
  if (onlyRun) return <Navigate to={onlyRun} replace />;

  const workflow = workflowById(detail.study.workflowId);
  if (!workflow)
    return (
      <Notice
        title="Can't show this study"
        body={`Its workflow, ${detail.study.workflowId}, isn't in this version of Voluma.`}
      />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StudyHeader detail={detail} workflow={workflow} tab={tab} onTab={setTab} />
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
          <button
            type="button"
            onClick={() => void study.refetch()}
            className="cursor-pointer text-primary-text hover:underline"
          >
            Try again
          </button>
        </p>
      )}
      <div
        id={PANEL_ID}
        role="tabpanel"
        aria-label={tab === "overview" ? "Overview" : tab === "check" ? "To check" : "Scans"}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[90rem] px-6 py-5 max-[760px]:px-3 max-[760px]:py-4">
          {tab === "overview" && (
            <Overview detail={detail} workflow={workflow} onTab={setTab} openChecks={openChecks} />
          )}
          {tab === "check" && (
            <ToCheck detail={detail} workflow={workflow} openChecks={openChecks} />
          )}
          {tab === "scans" && <ScansTable detail={detail} workflow={workflow} />}
        </div>
      </div>
      {panel && (
        <CheckPanel
          items={panel.queue}
          start={panel.start}
          onClose={() => setPanel(undefined)}
          onAccepted={() => void client.invalidateQueries({ queryKey: ["study"] })}
        />
      )}
    </div>
  );
}

function StudyHeader({
  detail,
  workflow,
  tab,
  onTab,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
  tab: TabId;
  onTab: (tab: TabId) => void;
}) {
  const c = studyCounts(detail);
  const scansLabel = [
    `${c.done} of ${c.scans} done`,
    c.running && `${c.running} running`,
    c.waiting && `${c.waiting} waiting`,
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
      <Tabs
        label="Study"
        controls={PANEL_ID}
        value={tab}
        onChange={onTab}
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
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" className="gap-1 px-2.5">
          Study details
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-50 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ui">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="m-0 tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Loading() {
  return (
    <main aria-busy="true" className="grid flex-1 place-content-center">
      {/* Shown only when loading is slow, so a fast load doesn't flash it. */}
      <p className="animate-[appear_200ms_ease-out_600ms_both] text-ui text-muted-foreground">
        Loading the study…
      </p>
    </main>
  );
}

function LoadError({ error, retry }: { error: Error; retry: () => void }) {
  return error instanceof ApiError && error.status === 404 ? (
    <Notice
      title="This study isn't here"
      body="It may have been removed, or it belongs to another lab."
    />
  ) : (
    <Notice
      title="Couldn't load the study"
      body="Check your connection, then try again."
      retry={retry}
    />
  );
}

function Notice({ title, body, retry }: { title: string; body: string; retry?: () => void }) {
  return (
    <main className="grid flex-1 place-content-center gap-3 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-ui text-muted-foreground">{body}</p>
      <div className="flex justify-center gap-2">
        {retry && (
          <Button variant="primary" size="sm" onClick={retry}>
            Try again
          </Button>
        )}
        <Link
          to="/"
          className="inline-flex h-8 items-center rounded-lg border border-border bg-card px-3.5 text-ui font-medium hover:bg-accent"
        >
          Go to Home
        </Link>
      </div>
    </main>
  );
}
