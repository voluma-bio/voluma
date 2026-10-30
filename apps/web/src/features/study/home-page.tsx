/**
 * Home (`/`): what needs the researcher (one action per row), what is running, and every
 * study. A study of one shows as its scan and links straight to its run.
 *
 * Data: `listStudies` alone; each study carries each scan's newest run in brief. It refetches
 * every 5 s while its last answer shows a live run.
 */
import { useQuery } from "@tanstack/react-query";
import { listStudies } from "@voluma/api-client";
import type { StudyRunSummary, StudySummary } from "@voluma/contracts/study";
import {
  Box,
  Button,
  Count,
  EmptyState,
  ErrorState,
  type LinkRenderProps,
  List,
  LoadingState,
  Progress,
  Row,
  RowLink,
  type Status,
  StatusMark,
  Table,
} from "@voluma/ui";
import { runHref, studyStatus } from "@voluma/ui/run";
import { workflowById } from "@voluma/workflow/bundled";
import { Link } from "react-router";

const LIVE = 5000;

interface StudyView {
  study: StudySummary;
  /** A study of one's run, once it has one. */
  one: StudyRunSummary | undefined;
  /** A live study of one: its run's tasks done; else its scans with a completed run. */
  progress: { done: number; total: number };
  href: string;
}

function view(study: StudySummary): StudyView {
  const one = study.scanCount === 1 ? study.newestRuns[0] : undefined;
  return {
    study,
    one,
    progress:
      one && isLive(one)
        ? { done: one.tasks?.done ?? 0, total: one.tasks?.total ?? 0 }
        : { done: study.scansCompleted, total: study.scanCount },
    href: one ? runHref(one) : `/studies/${study.id}`,
  };
}

const isLive = ({ state }: StudyRunSummary) => state.status !== "ended";
const failed = ({ state }: StudyRunSummary) =>
  state.status === "ended" && state.outcome === "failed";

/** "Today", "Yesterday", "3 days ago", then the day ("12 Oct"). */
function relativeDay(iso: string): string {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((day(new Date()) - day(new Date(iso))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function HomePage() {
  const studies = useQuery({
    queryKey: ["studies"],
    queryFn: listStudies,
    refetchInterval: (q) => (q.state.data?.some((s) => s.newestRuns.some(isLive)) ? LIVE : false),
  });

  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="flex-1 text-2xl font-semibold">Home</h1>
      <Button asChild variant="primary">
        <Link to="/new">Run on new scans</Link>
      </Button>
    </div>
  );

  let body: React.ReactNode;
  // A failed refetch keeps what is on screen; only a first load that fails shows the error.
  if (studies.isError && !studies.data) {
    body = (
      <ErrorState title="Couldn't load your studies" onRetry={() => void studies.refetch()}>
        Check your connection, then try again.
      </ErrorState>
    );
  } else if (!studies.data) {
    body = <LoadingState label="Loading your studies" />;
  } else if (studies.data.length === 0) {
    body = (
      <EmptyState title="No studies yet" className="rounded-lg border border-border bg-card">
        Drop one scan or a whole study's scans, with your sample sheet if you have one.
      </EmptyState>
    );
  } else {
    body = <Dashboard views={studies.data.map(view)} />;
  }

  return (
    <main className="mx-auto grid w-full max-w-[1040px] content-start gap-8 px-6 pt-7 pb-16 max-[760px]:px-4">
      {header}
      {body}
    </main>
  );
}

function Dashboard({ views }: { views: StudyView[] }) {
  const needs = views.flatMap(needsYou);
  const running = views.filter((v) => v.study.newestRuns.some(isLive));
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start gap-6 max-[860px]:grid-cols-1">
        <Box
          title="Needs you"
          count={needs.length > 0 && <Count tone="check">{needs.length}</Count>}
          className={BOXED}
        >
          {needs.length > 0 ? (
            <List columns="auto" label="Needs you">
              {needs}
            </List>
          ) : (
            <EmptyState title="Nothing needs you">
              Runs that fail or wait for your check show here.
            </EmptyState>
          )}
        </Box>
        <Box title="Running" className={BOXED}>
          {running.length > 0 ? (
            <List columns="10rem" label="Running">
              {running.map((v) => (
                <RunningRow key={v.study.id} view={v} />
              ))}
            </List>
          ) : (
            <EmptyState title="Nothing running" />
          )}
        </Box>
      </div>
      <StudyTable views={views} />
    </>
  );
}

/** Home's boxes stand alone on the page, so each draws its own frame. */
const BOXED = "overflow-hidden rounded-lg border border-border";

/** A study's row as a link through the router. */
const linkTo = (href: string) => (props: LinkRenderProps) => <Link to={href} {...props} />;

/** A study's one "Needs you" row, or none. Example studies are read-only, so they ask nothing. */
function needsYou(v: StudyView): React.ReactNode[] {
  const { study, one } = v;
  if (study.example) return [];
  const row = (tone: "check" | "destructive", detail: string, action: string, to: string) => (
    <Row
      key={study.id}
      title={one ? one.inputName : study.name}
      subtitle={
        <span className={tone === "check" ? "text-check" : "text-destructive"}>{detail}</span>
      }
      cells={[
        <Button key="action" asChild size="sm">
          <Link to={to}>{action}</Link>
        </Button>,
      ]}
    />
  );
  if (one) {
    if (one.state.status === "ended" && one.state.outcome === "failed")
      return [
        row("destructive", one.state.error ?? "The run failed.", "See what happened", v.href),
      ];
    if (one.state.status === "awaiting-keys")
      return [row("check", "Waiting for your keys to carry on.", "Add your keys", v.href)];
    if (study.toCheck > 0) return [row("check", `${study.toCheck} to check`, "Check", v.href)];
    return [];
  }
  const parts: string[] = [];
  if (study.toCheck > 0) {
    // `toCheck` sums each scan's newest completed run, which `newestRuns` lacks for a scan
    // rerunning; the scan count is exact only when the newest runs hold every open check.
    const open = study.newestRuns.filter((r) => (r.review?.remainingToCheck ?? 0) > 0);
    const shown = open.reduce((n, r) => n + (r.review?.remainingToCheck ?? 0), 0);
    parts.push(
      shown === study.toCheck
        ? `${study.toCheck} to check across ${plural(open.length, "scan")}.`
        : `${study.toCheck} to check.`,
    );
  }
  const failures = study.newestRuns.filter(failed);
  if (failures.length > 0)
    parts.push(
      `${plural(failures.length, "run")} failed: ${failures.map((r) => r.inputName).join(", ")}.`,
    );
  const keys = study.newestRuns.filter((r) => r.state.status === "awaiting-keys").length;
  if (keys > 0) parts.push(`${plural(keys, "run")} waiting for your keys.`);
  if (parts.length === 0) return [];
  return [
    row(failures.length > 0 ? "destructive" : "check", parts.join(" "), "Open the study", v.href),
  ];
}

function RunningRow({ view: v }: { view: StudyView }) {
  const { study, one, progress } = v;
  let detail: string;
  if (one) {
    detail =
      one.state.status === "queued"
        ? one.state.waitingForProvider
          ? "The AI is unavailable"
          : one.state.position === 1
            ? "Starts next"
            : `Waiting, place ${one.state.position} in line`
        : one.state.status === "awaiting-keys"
          ? "Waiting for your keys"
          : "Running";
  } else {
    const live = study.newestRuns.filter(isLive);
    const running = live.filter((r) => r.state.status === "running").length;
    const held = live.filter(
      (r) => r.state.status === "queued" && r.state.waitingForProvider,
    ).length;
    const waiting = live.length - running - held;
    detail = [
      running > 0 && `${running} running`,
      waiting > 0 && `${waiting} waiting`,
      held > 0 && `${held} waiting for the AI`,
      study.scanCount > study.newestRuns.length &&
        `${study.scanCount - study.newestRuns.length} not started`,
    ]
      .filter(Boolean)
      .join(", ");
  }
  return (
    <RowLink
      to={linkTo(v.href)}
      title={one ? one.inputName : study.name}
      subtitle={detail}
      cells={[<DoneBar key="bar" {...progress} />]}
    />
  );
}

/** Scans (or a live run's tasks) done, out of all of them. */
function DoneBar({ done, total }: { done: number; total: number }) {
  const states: Status[] = Array.from({ length: total }, (_, i) => (i < done ? "done" : "waiting"));
  return (
    <Progress look="bar" states={states} label={total > 0 ? `${done} of ${total}` : undefined} />
  );
}

function StudyTable({ views }: { views: StudyView[] }) {
  return (
    <Box title="Studies" className={BOXED}>
      <Table
        label="Studies"
        rows={views}
        rowKey={(v) => v.study.id}
        rowLink={(v) => linkTo(v.href)}
        className="rounded-none border-0"
        columns={[
          {
            key: "study",
            header: "Study",
            cell: (v) => (
              <>
                <span className="block truncate">{v.one ? v.one.inputName : v.study.name}</span>
                <span className="block truncate text-sm font-normal text-fg-subtle">
                  {v.study.scanCount === 1 ? "One scan" : plural(v.study.scanCount, "scan")}
                  {v.study.example && ", an example"}
                </span>
              </>
            ),
          },
          {
            key: "progress",
            header: "Progress",
            cell: (v) => (
              <span className="flex min-w-28 items-center gap-2.5">
                <DoneBar {...v.progress} />
              </span>
            ),
          },
          {
            key: "status",
            header: "Status",
            cell: (v) => {
              const chip = studyStatus({
                scans: v.study.scanCount,
                newest: v.study.newestRuns,
                toCheck: v.study.toCheck,
              });
              return <StatusMark {...chip} />;
            },
          },
          {
            key: "workflow",
            header: "Workflow",
            cell: (v) => (
              <span className="text-sm text-muted-foreground">
                {workflowById(v.study.workflowId)?.name ?? v.study.workflowId}
              </span>
            ),
          },
          {
            key: "activity",
            header: "Last activity",
            align: "end",
            cell: (v) => (
              <span className="text-sm whitespace-nowrap text-muted-foreground">
                {relativeDay(v.study.lastActivityAt)}
              </span>
            ),
          },
        ]}
      />
    </Box>
  );
}
