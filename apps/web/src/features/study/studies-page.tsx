/**
 * Studies (`/`, what the app opens on): which study, and what is in it. Every study of the lab,
 * newest activity first, each row with its samples' marks, what is happening now and its status
 * counts. Like a file browser's details pane, a click selects a study and the right side
 * describes it (details, samples by group, the headline measurement, recent activity); the row's
 * chevron, a double-click, Enter or "Open study" opens it. Up and Down move the selection. A study
 * of one opens its input.
 *
 * Data: `listStudies` for the list (it refetches every 5 s while a run is live); the selected
 * study's `getStudy` for the side.
 */
import { useQuery } from "@tanstack/react-query";
import { runThumbnailUrl } from "@voluma/api-client";
import { studiesQuery, studyQuery } from "@voluma/api-client/query";
import type { StudyDetail, StudyRunSummary, StudySummary } from "@voluma/contracts/study";
import {
  inputHref,
  inputStatus,
  isLive,
  liveStatus,
  placeOfStatus,
  plural,
  useNow,
  whenText,
} from "@voluma/run-view";
import {
  Breadcrumb,
  Button,
  cx,
  EmptyState,
  ErrorState,
  INPUT_WORD,
  LoadingState,
  Progress,
  ShellHeading,
  SidePanel,
  type Status,
  StatusGlyph,
  Thumbnail,
} from "@voluma/ui";
import { workflowById } from "@voluma/workflow/bundled";
import { ChevronRight, Info, Plus } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { PLACES, type Place, placeOf } from "./study/study-model";
import { HeadlineBlock, RecentActivity, SideBlock, StudyFacts } from "./study/study-side";

/** Where a study opens: its page, or a study of one's input once it has a run. */
const hrefOf = (study: StudySummary) => {
  const one = study.inputCount === 1 ? study.newestRuns[0] : undefined;
  return one ? inputHref(study.id, one.inputId) : `/studies/${study.id}`;
};

/** One mark per sample: its newest run's status; a sample with no run waits. */
function marksOf(study: StudySummary): Status[] {
  const ran = study.newestRuns.map((r) => liveStatus(r).status);
  return [...ran, ...Array<Status>(Math.max(0, study.inputCount - ran.length)).fill("waiting")];
}

/** How many samples sit in each place, as the study page groups them. */
function placeCounts(study: StudySummary): Map<Place, number> {
  const counts = new Map<Place, number>();
  const add = (p: Place, n = 1) => counts.set(p, (counts.get(p) ?? 0) + n);
  for (const run of study.newestRuns)
    add(placeOfStatus(liveStatus(run).status, run.waiting, study.example));
  if (study.inputCount > study.newestRuns.length)
    add("not-started", study.inputCount - study.newestRuns.length);
  return counts;
}

const COUNT_WORD: Record<Place, string> = {
  "waiting-on-you": "waiting on you",
  "needs-you": "need you",
  running: "running",
  done: "done",
  "not-started": "not started",
};

/** The places the researcher has to act on: counted in bold, without a mark. */
const ACT_ON = new Set<Place>(["waiting-on-you", "needs-you"]);

const COUNT_MARK: Record<Place, Status> = {
  "waiting-on-you": "check",
  "needs-you": "check",
  running: "running",
  done: "done",
  "not-started": "waiting",
};

export function StudiesPage() {
  const navigate = useNavigate();
  const studies = useQuery(studiesQuery());
  const [picked, setPicked] = useState<string | null>(null);
  const list = studies.data ?? [];
  const selected = list.find((s) => s.id === picked) ?? list[0];
  const now = useNow(list.some((s) => s.newestRuns.some(isLive)));

  const move = (event: KeyboardEvent) => {
    if (!selected) return;
    const at = list.indexOf(selected);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = list[at + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) setPicked(next.id);
    } else if (event.key === "Enter") navigate(hrefOf(selected));
  };

  let body: React.ReactNode;
  // A failed refetch keeps what is on screen; only a first load that fails shows the error.
  if (studies.isError && !studies.data) {
    body = (
      <ErrorState title="Couldn't load your studies" onRetry={() => void studies.refetch()}>
        Check your connection, then try again.
      </ErrorState>
    );
  } else if (!studies.data) {
    body = <LoadingState label="Loading your studies" rows={3} />;
  } else if (list.length === 0) {
    body = (
      <EmptyState title="No studies yet">
        A study runs the workflow on your {INPUT_WORD.many}: one {INPUT_WORD.one}, or a whole
        study's with your sample sheet. <Link to="/new">Start one</Link>.
      </EmptyState>
    );
  } else {
    body = (
      <div
        role="listbox"
        tabIndex={0}
        aria-label="Studies"
        aria-activedescendant={selected && `study-${selected.id}`}
        onKeyDown={move}
        className="grid gap-1 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {list.map((study) => (
          <StudyRow
            key={study.id}
            study={study}
            selected={study === selected}
            now={now}
            onSelect={() => setPicked(study.id)}
            onOpen={() => navigate(hrefOf(study))}
          />
        ))}
      </div>
    );
  }

  const samples = list.reduce((n, s) => n + s.inputCount, 0);
  return (
    <>
      <ShellHeading>
        <Breadcrumb trail={[]} current="Studies" />
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link to="/new">
            <Plus aria-hidden />
            New study
          </Link>
        </Button>
      </ShellHeading>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-6 pt-5 pb-8">
          <header className="mb-4 flex items-baseline gap-3">
            <h1 className="m-0 text-xl font-semibold">Studies</h1>
            {list.length > 0 && (
              <span className="text-sm text-muted-foreground">
                {plural(list.length, "study", "studies")} ·{" "}
                {plural(samples, INPUT_WORD.one, INPUT_WORD.many)}
              </span>
            )}
          </header>
          {body}
        </div>
        {selected && (
          <SidePanel side="right" title={selected.name} icon={<Info />}>
            <StudyPane study={selected} />
          </SidePanel>
        )}
      </div>
    </>
  );
}

function StudyRow({
  study,
  selected,
  now,
  onSelect,
  onOpen,
}: {
  study: StudySummary;
  selected: boolean;
  now: number;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const workflow = workflowById(study.workflowId);
  const counts = placeCounts(study);
  return (
    // The listbox owns the keys (aria-activedescendant); a row is chosen by pointer.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys.
    <div
      id={`study-${study.id}`}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cx(
        "grid cursor-default grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-6 rounded-lg px-3 py-3",
        selected ? "bg-select-tint" : "hover:bg-accent",
      )}
    >
      <div className="grid min-w-0 gap-1">
        <p className="m-0 flex min-w-0 items-baseline gap-2.5">
          <span className="truncate font-semibold">{study.name}</span>
          <span className="truncate text-sm text-muted-foreground">
            {[
              workflow?.name ?? study.workflowId,
              plural(study.inputCount, INPUT_WORD.one, INPUT_WORD.many),
              study.example && "an example",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </p>
        <Latest study={study} now={now} />
      </div>
      <div className="grid justify-items-end gap-1.5">
        <Progress states={marksOf(study)} className="max-w-60" />
        <span className="flex gap-3 text-sm whitespace-nowrap">
          {PLACES.filter((p) => counts.has(p.place)).map((p) => (
            <Count
              key={p.place}
              n={counts.get(p.place) ?? 0}
              word={COUNT_WORD[p.place]}
              mark={ACT_ON.has(p.place) ? undefined : COUNT_MARK[p.place]}
              emphasis={ACT_ON.has(p.place)}
            />
          ))}
        </span>
      </div>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Open ${study.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-subtle hover:bg-secondary hover:text-foreground"
      >
        <ChevronRight aria-hidden className="size-4" />
      </button>
    </div>
  );
}

/** One status count of a study row; the emphasised ones are what the researcher has to act on. */
function Count({
  n,
  word,
  mark,
  emphasis = false,
}: {
  n: number;
  word: string;
  mark?: Status;
  emphasis?: boolean;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1",
        emphasis ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {mark && <StatusGlyph status={mark} className="size-3" />}
      <span className={cx("tabular-nums", emphasis && "font-semibold")}>{n}</span>
      {word}
    </span>
  );
}

/** What moved last: a live sample and where it is, else when the study last changed. */
function Latest({ study, now }: { study: StudySummary; now: number }) {
  const live: StudyRunSummary | undefined = study.newestRuns.find(isLive);
  const when = whenText(study.lastActivityAt, now);
  if (!live) return <p className="m-0 text-sm text-fg-subtle">Last activity {when}</p>;
  const { label, status } = liveStatus(live);
  return (
    <p className="m-0 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
      <StatusGlyph status={status} className="size-3" />
      <span className="font-mono text-xs font-medium text-foreground">{live.inputName}</span>
      <span className="truncate">
        {label.toLowerCase()} · {when}
      </span>
    </p>
  );
}

/** The selected study, described: what you came to do first, then what it is and what moved. */
function StudyPane({ study }: { study: StudySummary }) {
  const detail = useQuery(studyQuery(study.id));
  // The detail polls only once it holds a live run; the list (polling too) notices a new one first.
  const liveRuns = study.newestRuns
    .filter(isLive)
    .map((r) => r.runId)
    .join();
  const { refetch } = detail;
  useEffect(() => {
    if (liveRuns) void refetch();
  }, [liveRuns, refetch]);
  const workflow = workflowById(study.workflowId);
  return (
    <div className="grid content-start gap-7 px-4 pt-3 pb-6">
      <Button asChild className="justify-self-start">
        <Link to={hrefOf(study)}>
          {study.inputCount === 1 ? `Open ${INPUT_WORD.one}` : "Open study"}
          <ChevronRight aria-hidden />
        </Link>
      </Button>
      {detail.data && workflow ? (
        <>
          <SideBlock title="Details">
            <StudyFacts detail={detail.data} workflow={workflow} />
          </SideBlock>
          <SamplesBlock study={study} detail={detail.data} />
          <HeadlineBlock detail={detail.data} workflow={workflow} />
          <RecentActivity detail={detail.data} limit={4} />
        </>
      ) : detail.isError ? (
        <ErrorState title="Couldn't load this study" onRetry={() => void detail.refetch()}>
          Check your connection, then try again.
        </ErrorState>
      ) : (
        <LoadingState label="Loading the study" rows={4} />
      )}
    </div>
  );
}

/** The status counts, each opening the study on that group, then every sample by its group. */
function SamplesBlock({ study, detail }: { study: StudySummary; detail: StudyDetail }) {
  const counts = PLACES.map((p) => ({
    ...p,
    n: detail.inputs.filter((s) => placeOf(s, detail.study.example) === p.place).length,
  })).filter((p) => p.n > 0);
  const grouped = detail.inputs.some((s) => s.member.group !== null);
  const groups = [...new Set(detail.inputs.map((s) => s.member.group ?? ""))];
  const many = study.inputCount > 1;
  return (
    <SideBlock
      title={INPUT_WORD.Many}
      aside={<span className="text-fg-subtle">{study.inputCount}</span>}
    >
      {many && (
        <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {counts.map((p) => (
            <Link
              key={p.place}
              to={`/studies/${study.id}?status=${p.place}`}
              className="inline-flex items-center gap-1 rounded-sm hover:underline"
            >
              <span className="font-semibold tabular-nums">{p.n}</span> {COUNT_WORD[p.place]}
            </Link>
          ))}
        </p>
      )}
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {groups.map((g) => {
          const inputs = detail.inputs.filter((s) => (s.member.group ?? "") === g);
          return (
            <div key={g} className="contents">
              {grouped && (
                <dt className="whitespace-nowrap text-fg-subtle">
                  {g || "No group"} <span className="tabular-nums">{inputs.length}</span>
                </dt>
              )}
              <dd className={cx("m-0 flex flex-wrap gap-x-3 gap-y-1", !grouped && "col-span-2")}>
                {inputs.map((s) => {
                  const run = s.runs[0];
                  const name = (
                    <>
                      <Thumbnail
                        size={36}
                        src={run && runThumbnailUrl(run.id)}
                        mark={<StatusGlyph status={inputStatus(s).status} className="size-3" />}
                      />
                      <span className="font-mono text-xs">{s.member.subject}</span>
                    </>
                  );
                  return run ? (
                    <Link
                      key={s.member.inputId}
                      to={inputHref(study.id, s.member.inputId)}
                      className="inline-flex items-center gap-2 rounded-sm hover:underline"
                    >
                      {name}
                    </Link>
                  ) : (
                    <span key={s.member.inputId} className="inline-flex items-center gap-2">
                      {name}
                    </span>
                  );
                })}
              </dd>
            </div>
          );
        })}
      </dl>
    </SideBlock>
  );
}
