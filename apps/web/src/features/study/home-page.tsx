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
import { StatusBadge } from "@voluma/ui";
import { runHref, studyStatus } from "@voluma/ui/run";
import { workflowById } from "@voluma/workflow/bundled";
import { Link } from "react-router";
import { ButtonLink, Delayed, LoadError, ProgressBar } from "./parts";

const LIVE = 5000;

interface StudyView {
  study: StudySummary;
  /** A study of one's run, once it has one. */
  one: StudyRunSummary | undefined;
  /** A live study of one: its run's tasks done; else its scans with a completed run. */
  progress: { done: number; total: number; label: string };
  href: string;
}

function view(study: StudySummary): StudyView {
  const one = study.scanCount === 1 ? study.newestRuns[0] : undefined;
  return {
    study,
    one,
    progress:
      one && isLive(one)
        ? { done: one.tasks?.done ?? 0, total: one.tasks?.total ?? 0, label: "Tasks done" }
        : { done: study.scansCompleted, total: study.scanCount, label: "Scans done" },
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
      <ButtonLink to="/new" variant="primary">
        Run on new scans
      </ButtonLink>
    </div>
  );

  let body: React.ReactNode;
  // A failed refetch keeps what is on screen; only a first load that fails shows the error.
  if (studies.isError && !studies.data) {
    body = <LoadError what="your studies" retry={() => void studies.refetch()} />;
  } else if (!studies.data) {
    body = <Delayed>Loading your studies…</Delayed>;
  } else if (studies.data.length === 0) {
    body = (
      <section className="grid justify-items-start gap-1 rounded-xl border border-border bg-card px-5 py-6">
        <h2 className="font-semibold">No studies yet</h2>
        <p className="text-muted-foreground">
          Drop one scan or a whole study's scans, with your sample sheet if you have one.
        </p>
      </section>
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
        <section aria-labelledby="needs-you" className="grid gap-3">
          <h2 id="needs-you" className="flex items-center gap-2 text-lg font-semibold">
            Needs you
            {needs.length > 0 && (
              <span className="rounded-full bg-check-tint px-2 text-meta font-semibold text-check tabular-nums">
                {needs.length}
              </span>
            )}
          </h2>
          {needs.length > 0 ? (
            <ul className="overflow-hidden rounded-xl border border-border bg-card">{needs}</ul>
          ) : (
            <p className="text-muted-foreground">Nothing needs you.</p>
          )}
        </section>
        <section aria-labelledby="running" className="grid gap-3">
          <h2 id="running" className="text-lg font-semibold">
            Running
          </h2>
          {running.length > 0 ? (
            <ul className="overflow-hidden rounded-xl border border-border bg-card">
              {running.map((v) => (
                <RunningRow key={v.study.id} view={v} />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Nothing running.</p>
          )}
        </section>
      </div>
      <StudyTable views={views} />
    </>
  );
}

/** A study's one "Needs you" row, or none. Example studies are read-only, so they ask nothing. */
function needsYou(v: StudyView): React.ReactNode[] {
  const { study, one } = v;
  if (study.example) return [];
  const row = (tone: "check" | "destructive", detail: string, action: string, to: string) => (
    <li
      key={study.id}
      className={`flex items-center gap-4 border-b border-l-3 border-b-line-subtle px-4 py-2.5 last:border-b-0 max-[520px]:flex-wrap ${
        tone === "check" ? "border-l-check" : "border-l-destructive"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{one ? one.inputName : study.name}</p>
        <p className="line-clamp-2 text-ui text-muted-foreground">{detail}</p>
      </div>
      <ButtonLink to={to} size="sm">
        {action}
      </ButtonLink>
    </li>
  );
  if (one) {
    if (one.state.status === "ended" && one.state.outcome === "failed")
      return [
        row("destructive", one.state.error ?? "The run failed.", "See what happened", v.href),
      ];
    if (one.state.status === "awaiting-keys")
      return [row("check", "Waiting for your keys to carry on.", "Add your keys", v.href)];
    // Only when its newest run is the completed one: else the checks are an older run's.
    if (one.state.status === "ended" && one.state.outcome === "completed" && study.toCheck > 0)
      return [row("check", `${study.toCheck} to check`, "Check", v.href)];
    return [];
  }
  const parts: string[] = [];
  if (study.toCheck > 0) parts.push(`${study.toCheck} to check.`);
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
        ? one.state.position === 1
          ? "Starts next"
          : `Waiting, place ${one.state.position} in line`
        : one.state.status === "awaiting-keys"
          ? "Waiting for your keys"
          : "Running";
  } else {
    const live = study.newestRuns.filter(isLive);
    const running = live.filter((r) => r.state.status === "running").length;
    detail = [
      running > 0 && `${running} running`,
      live.length > running && `${live.length - running} waiting`,
      study.scanCount > study.newestRuns.length &&
        `${study.scanCount - study.newestRuns.length} not started`,
    ]
      .filter(Boolean)
      .join(", ");
  }
  return (
    <li className="border-b border-line-subtle last:border-b-0">
      <Link
        to={v.href}
        className="grid grid-cols-[minmax(0,1fr)_7rem_2.75rem] items-center gap-3 px-4 py-3 hover:bg-background"
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">{one ? one.inputName : study.name}</span>
          <span className="block truncate text-ui text-muted-foreground">{detail}</span>
        </span>
        <ProgressBar {...progress} />
        <Fraction {...progress} />
      </Link>
    </li>
  );
}

/** `3/9`; nothing before a run's plan exists. */
function Fraction({ done, total }: { done: number; total: number }) {
  return (
    <span className="min-w-8 text-right text-ui text-muted-foreground tabular-nums">
      {total > 0 && `${done}/${total}`}
    </span>
  );
}

const COLUMNS =
  "grid grid-cols-[minmax(0,1.6fr)_minmax(7rem,1fr)_minmax(6.5rem,auto)_minmax(0,1fr)_6.5rem] items-center gap-4 max-[760px]:grid-cols-[minmax(0,1fr)_auto]";

function StudyTable({ views }: { views: StudyView[] }) {
  return (
    <section aria-labelledby="studies" className="grid gap-3">
      <h2 id="studies" className="text-lg font-semibold">
        Studies
      </h2>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div
          aria-hidden
          className={`${COLUMNS} border-b border-border px-4 py-2.5 text-meta font-medium text-fg-subtle max-[760px]:hidden`}
        >
          <span>Study</span>
          <span>Progress</span>
          <span>Status</span>
          <span>Workflow</span>
          <span className="text-right">Last activity</span>
        </div>
        <ul>
          {views.map((v) => {
            const chip = studyStatus({
              scans: v.study.scanCount,
              newest: v.study.newestRuns,
              toCheck: v.study.toCheck,
            });
            return (
              <li key={v.study.id} className="border-b border-line-subtle last:border-b-0">
                <Link to={v.href} className={`${COLUMNS} px-4 py-3 hover:bg-background`}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {v.one ? v.one.inputName : v.study.name}
                    </span>
                    <span className="block truncate text-ui text-muted-foreground">
                      {v.study.scanCount === 1 ? "One scan" : plural(v.study.scanCount, "scan")}
                      {v.study.example && ", an example"}
                    </span>
                  </span>
                  <span className="flex items-center gap-2.5 max-[760px]:hidden">
                    <ProgressBar {...v.progress} />
                    <Fraction {...v.progress} />
                  </span>
                  <span>
                    <StatusBadge tone={chip.tone}>{chip.label}</StatusBadge>
                  </span>
                  <span className="truncate text-ui text-muted-foreground max-[760px]:hidden">
                    {workflowById(v.study.workflowId)?.name ?? v.study.workflowId}
                  </span>
                  <span className="text-right text-ui text-muted-foreground max-[760px]:hidden">
                    {relativeDay(v.study.lastActivityAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
