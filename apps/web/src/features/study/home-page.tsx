/**
 * Home (`/`): what needs the researcher (one action per row), what is running, and every
 * study. A study of one shows as its scan and links straight to its run.
 *
 * Data: `listStudies` for the table and `listRuns` for each study's runs (which run a study of
 * one opens, which runs failed or wait for keys, a live run's tasks done). Both refetch every
 * 5 s while any run is live.
 */
import { useQuery } from "@tanstack/react-query";
import { listRuns, listStudies } from "@voluma/api-client";
import type { Run } from "@voluma/contracts/run";
import type { StudySummary } from "@voluma/contracts/study";
import { StatusBadge, type StatusTone } from "@voluma/ui";
import { RunBadge, runHref } from "@voluma/ui/run";
import { workflowById } from "@voluma/workflow/bundled";
import { Link } from "react-router";
import { ButtonLink, Delayed, LoadError, ProgressBar } from "./parts";

const LIVE = 5000;

/** A study with its runs, newest first, and each scan's newest run. */
interface StudyView {
  study: StudySummary;
  runs: Run[];
  newest: Run[];
  /** A live study of one: its run's tasks done; else its scans with a completed run. */
  progress: { done: number; total: number; label: string };
  href: string;
}

function view(study: StudySummary, runs: Run[]): StudyView {
  const newest = new Map<string, Run>();
  const completed = new Set<string>();
  for (const run of runs) {
    if (!newest.has(run.input.id)) newest.set(run.input.id, run);
    if (run.state.status === "ended" && run.state.outcome === "completed")
      completed.add(run.input.id);
  }
  const one = study.scanCount === 1 ? runs[0] : undefined;
  return {
    study,
    runs,
    newest: [...newest.values()],
    progress:
      one && isLive(one)
        ? { done: one.tasks?.done ?? 0, total: one.tasks?.total ?? 0, label: "Tasks done" }
        : { done: completed.size, total: study.scanCount, label: "Scans done" },
    href: one ? runHref(one) : `/studies/${study.id}`,
  };
}

const isLive = (run: Run) => run.state.status !== "ended";
const failed = (run: Run) => run.state.status === "ended" && run.state.outcome === "failed";

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
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: listRuns,
    refetchInterval: (q) => (q.state.data?.some(isLive) ? LIVE : false),
  });
  const live = runs.data?.some(isLive) ?? false;
  const studies = useQuery({
    queryKey: ["studies"],
    queryFn: listStudies,
    refetchInterval: live ? LIVE : false,
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
  if ((studies.isError && !studies.data) || (runs.isError && !runs.data)) {
    body = (
      <LoadError
        what="your studies"
        retry={() => {
          void studies.refetch();
          void runs.refetch();
        }}
      />
    );
  } else if (!studies.data || !runs.data) {
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
    const byStudy = new Map<string, Run[]>();
    for (const run of runs.data)
      byStudy.set(run.studyId, [...(byStudy.get(run.studyId) ?? []), run]);
    const views = studies.data.map((s) => view(s, byStudy.get(s.id) ?? []));
    body = <Dashboard views={views} />;
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
  const running = views.filter((v) => v.runs.some(isLive));
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
  const { study } = v;
  if (study.example) return [];
  const one = study.scanCount === 1 ? v.newest[0] : undefined;
  const row = (tone: "check" | "destructive", detail: string, action: string, to: string) => (
    <li
      key={study.id}
      className={`flex items-center gap-4 border-b border-l-3 border-b-line-subtle px-4 py-2.5 last:border-b-0 max-[520px]:flex-wrap ${
        tone === "check" ? "border-l-check" : "border-l-destructive"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{one ? one.input.name : study.name}</p>
        <p className="line-clamp-2 text-ui text-muted-foreground">{detail}</p>
      </div>
      <ButtonLink to={to} size="sm">
        {action}
      </ButtonLink>
    </li>
  );
  if (one) {
    if (failed(one) && one.state.status === "ended")
      return [
        row("destructive", one.state.error ?? "The run failed.", "See what happened", runHref(one)),
      ];
    if (one.state.status === "awaiting-keys")
      return [row("check", "Waiting for your keys to carry on.", "Add your keys", runHref(one))];
    const open = one.review?.remainingToCheck ?? 0;
    if (open > 0) return [row("check", `${open} to check`, "Check", runHref(one))];
    return [];
  }
  const parts: string[] = [];
  if (study.toCheck > 0) {
    const scans = v.newest.filter((r) => (r.review?.remainingToCheck ?? 0) > 0).length;
    parts.push(`${study.toCheck} to check across ${plural(scans, "scan")}.`);
  }
  const failures = v.newest.filter(failed);
  if (failures.length > 0)
    parts.push(
      `${plural(failures.length, "run")} failed: ${failures.map((r) => r.input.name).join(", ")}.`,
    );
  const keys = v.newest.filter((r) => r.state.status === "awaiting-keys").length;
  if (keys > 0) parts.push(`${plural(keys, "run")} waiting for your keys.`);
  if (parts.length === 0) return [];
  return [
    row(failures.length > 0 ? "destructive" : "check", parts.join(" "), "Open the study", v.href),
  ];
}

function RunningRow({ view: v }: { view: StudyView }) {
  const { study, progress } = v;
  const one = study.scanCount === 1 ? v.newest[0] : undefined;
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
    const live = v.newest.filter(isLive);
    const running = live.filter((r) => r.state.status === "running").length;
    detail = [
      running > 0 && `${running} running`,
      live.length > running && `${live.length - running} waiting`,
      study.scanCount > v.newest.length && `${study.scanCount - v.newest.length} not started`,
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
          <span className="block truncate font-medium">{one ? one.input.name : study.name}</span>
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

/** A multi-scan study's chip: what most needs the researcher, else how far it got. */
function studyChip(v: StudyView): { label: string; tone: StatusTone } {
  const failures = v.newest.filter(failed).length;
  if (failures > 0) return { label: `${failures} failed`, tone: "destructive" };
  if (v.study.toCheck > 0) return { label: `${v.study.toCheck} to check`, tone: "check" };
  if (v.newest.some((r) => r.state.status === "running")) return { label: "Running", tone: "info" };
  if (v.newest.some((r) => r.state.status === "awaiting-keys"))
    return { label: "Needs your keys", tone: "check" };
  if (v.newest.some(isLive)) return { label: "Queued", tone: "neutral" };
  if (v.progress.done === v.study.scanCount) return { label: "Completed", tone: "primary" };
  return { label: v.progress.done > 0 ? "Partly run" : "Not started", tone: "neutral" };
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
            const one = v.study.scanCount === 1 ? v.newest[0] : undefined;
            const chip = studyChip(v);
            return (
              <li key={v.study.id} className="border-b border-line-subtle last:border-b-0">
                <Link to={v.href} className={`${COLUMNS} px-4 py-3 hover:bg-background`}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {one ? one.input.name : v.study.name}
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
                    {one ? (
                      <RunBadge run={one} />
                    ) : (
                      <StatusBadge tone={chip.tone}>{chip.label}</StatusBadge>
                    )}
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
