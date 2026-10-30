/**
 * Home (`/`): what needs the researcher (one action per row), what is running, and every
 * study with one mark per scan. A study of one shows as its scan and links straight to it.
 *
 * Data: `listStudies` alone; each study carries each scan's newest run in brief. It refetches
 * every 5 s while its last answer shows a live run.
 */
import { useQuery } from "@tanstack/react-query";
import { studiesQuery } from "@voluma/api-client/query";
import type { StudyRunSummary, StudySummary } from "@voluma/contracts/study";
import { isLive, liveStatus, plural, runHref, runStatus, studyStatus } from "@voluma/run-view";
import {
  Box,
  Breadcrumb,
  Button,
  Count,
  type Density,
  EmptyState,
  ErrorState,
  List,
  LoadingState,
  PageHead,
  Progress,
  RowLink,
  SegmentedControl,
  ShellHeading,
  type Status,
  StatusMark,
  Table,
} from "@voluma/ui";
import { workflowById } from "@voluma/workflow/bundled";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { linkTo } from "./link";

const LIVE = 5000;

interface StudyView {
  study: StudySummary;
  /** A study of one's run, once it has one. */
  one: StudyRunSummary | undefined;
  href: string;
}

function view(study: StudySummary): StudyView {
  const one = study.scanCount === 1 ? study.newestRuns[0] : undefined;
  return {
    study,
    one,
    href: one ? runHref(one) : `/studies/${study.id}`,
  };
}

const failed = ({ state }: StudyRunSummary) =>
  state.status === "ended" && state.outcome === "failed";

export function HomePage() {
  const studies = useQuery({
    ...studiesQuery(),
    refetchInterval: (q) => (q.state.data?.some((s) => s.newestRuns.some(isLive)) ? LIVE : false),
  });

  let body: React.ReactNode;
  // A failed refetch keeps what is on screen; only a first load that fails shows the error.
  if (studies.isError && !studies.data) {
    body = (
      <ErrorState
        className="m-6"
        title="Couldn't load your studies"
        onRetry={() => void studies.refetch()}
      >
        Check your connection, then try again.
      </ErrorState>
    );
  } else if (!studies.data) {
    body = <LoadingState label="Loading your studies" className="py-2" />;
  } else if (studies.data.length === 0) {
    body = (
      <EmptyState title="No studies yet">
        Run on new scans: one scan, or a whole study's with your sample sheet.
      </EmptyState>
    );
  } else {
    body = <Dashboard views={studies.data.map(view)} />;
  }

  return (
    <div className="shrink-0">
      <ShellHeading>
        <Breadcrumb current="Home" />
      </ShellHeading>
      <PageHead
        title="Home"
        actions={
          <Button asChild variant="primary">
            <Link to="/new">
              <Plus aria-hidden />
              Run on new scans
            </Link>
          </Button>
        }
      />
      {body}
    </div>
  );
}

function Dashboard({ views }: { views: StudyView[] }) {
  const needs = views.flatMap(needsYou);
  const running = views.flatMap((v) =>
    v.study.newestRuns.filter(isLive).map((run) => ({ run, study: v.one ? null : v.study })),
  );
  return (
    <>
      <div className="grid grid-cols-2 gap-px border-b border-border bg-border max-[860px]:grid-cols-1">
        <Box
          title="Needs you"
          count={needs.length > 0 && <Count tone="check">{needs.length}</Count>}
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
        <Box
          title="Running"
          count={running.length > 0 && <Count tone="running">{running.length}</Count>}
        >
          {running.length > 0 ? (
            <List columns="auto" label="Running">
              {running.map(({ run, study }) => (
                <RunningRow key={run.runId} run={run} study={study} />
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

/**
 * A study's one "Needs you" row, or none: what waits for the researcher in a sentence, the
 * number to check (or what stopped) beside it, and the row opens the study (a study of one, its
 * scan). Example studies are read-only, so they ask nothing.
 */
function needsYou(v: StudyView): React.ReactNode[] {
  const { study, one } = v;
  if (study.example) return [];
  const runs = one ? [one] : study.newestRuns;
  const failures = runs.filter(failed);
  const keys = runs.filter((r) => r.state.status === "awaiting-keys");
  const parts: string[] = [];
  if (study.toCheck > 0 && !one) {
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
  if (failures.length > 0)
    parts.push(
      one
        ? "The run stopped before it finished."
        : `${plural(failures.length, "scan")} stopped: ${failures.map((r) => r.inputName).join(", ")}.`,
    );
  if (keys.length > 0)
    parts.push(
      one
        ? "Paused until you add your API key."
        : `${plural(keys.length, "scan")} paused until you add your API key.`,
    );
  if (parts.length === 0 && study.toCheck === 0) return [];
  const cell =
    study.toCheck > 0 ? (
      <StatusMark status="check" label={`${study.toCheck} to check`} />
    ) : failures.length > 0 ? (
      <StatusMark status="stopped" />
    ) : (
      <StatusMark status="paused" label="Needs your keys" />
    );
  return [
    <RowLink
      key={study.id}
      to={linkTo(v.href)}
      title={one ? one.inputName : study.name}
      subtitle={parts.join(" ") || undefined}
      cells={[cell]}
    />,
  ];
}

/** A live run: its scan, its study (unless it is a study of one), and where it stands. */
function RunningRow({ run, study }: { run: StudyRunSummary; study: StudySummary | null }) {
  return (
    <RowLink
      to={linkTo(runHref(run))}
      title={run.inputName}
      subtitle={study?.name}
      cells={[<StatusMark key="s" {...liveStatus(run)} />]}
    />
  );
}

/** One mark per scan of the study: its newest run's state; a scan with no run waits. */
function scanMarks(study: StudySummary): Status[] {
  const ran = study.newestRuns.map((r) => runStatus(r).status);
  return [...ran, ...Array<Status>(Math.max(0, study.scanCount - ran.length)).fill("waiting")];
}

function StudyTable({ views }: { views: StudyView[] }) {
  const [density, setDensity] = useState<Density>("comfortable");
  return (
    <Box
      title="Your studies"
      count={<Count>{views.length}</Count>}
      tools={
        <SegmentedControl<Density>
          label="Rows"
          value={density}
          onValueChange={setDensity}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
        />
      }
    >
      <Table
        label="Your studies"
        density={density}
        rows={views}
        rowKey={(v) => v.study.id}
        rowLink={(v) => linkTo(v.href)}
        className="rounded-none border-x-0 border-b-0"
        columns={[
          {
            key: "study",
            header: "Study",
            cell: (v) => (
              <>
                <span className="block truncate">{v.one ? v.one.inputName : v.study.name}</span>
                {density === "comfortable" && (
                  <span className="block truncate text-sm font-normal text-fg-subtle">
                    {v.study.scanCount === 1 ? "One scan" : plural(v.study.scanCount, "scan")}.{" "}
                    {workflowById(v.study.workflowId)?.name ?? v.study.workflowId}
                    {v.study.example && ". An example"}
                  </span>
                )}
              </>
            ),
          },
          {
            key: "scans",
            header: "Scans, one mark each",
            cell: (v) => <Progress states={scanMarks(v.study)} className="max-w-60" />,
          },
          {
            key: "finished",
            header: "Finished",
            align: "end",
            cell: (v) => (
              <span className="text-sm whitespace-nowrap tabular-nums">
                {v.study.scansCompleted} of {v.study.scanCount}
              </span>
            ),
          },
          {
            key: "status",
            header: "Needs you",
            cell: (v) => {
              const chip = studyStatus({
                scans: v.study.scanCount,
                newest: v.study.newestRuns,
                toCheck: v.study.toCheck,
              });
              return <StatusMark {...chip} />;
            },
          },
        ]}
      />
    </Box>
  );
}
