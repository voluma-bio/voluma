/**
 * A study's page (`/studies/:id`): which sample needs me. Its samples grouped Needs you, Running,
 * Done (then Not started), each row with its picture, group and knee, its bar of measurements,
 * one line of status and when it last changed; a row opens the input review. `?status=<place>`
 * shows one group. On the right: the study's details,
 * its headline measurement with the way to Compare, and recent activity. Nothing here judges or
 * changes a result.
 */
import { runThumbnailUrl } from "@voluma/api-client";
import type { StudyInputDetail } from "@voluma/contracts/study";
import {
  inputLabel,
  inputStatus,
  liveStatus,
  needsYouOf,
  toCheckText,
  useNow,
  whenText,
} from "@voluma/run-view";
import {
  Button,
  Count,
  cx,
  INPUT_WORD,
  PageHead,
  SidePanel,
  StatusMark,
  Thumbnail,
  useFoldWhile,
} from "@voluma/ui";
import { ChevronRight } from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { measurementsOf } from "../workflow-measurements";
import { SampleBar } from "./sample-bar";
import { useStudy } from "./study-layout";
import {
  changedAt,
  hasBar,
  type Measurement,
  openHref,
  PLACES,
  placeOf,
  placeParam,
  segmentOf,
} from "./study-model";
import { HeadlineBlock, RecentActivity, StudyFacts } from "./study-side";

export function StudyPage() {
  const { detail, workflow } = useStudy();
  useFoldWhile("right", true, true);
  const [search] = useSearchParams();
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const row = [...document.querySelectorAll<HTMLElement>("li[id]")].find(
      (element) => `#${encodeURIComponent(element.id)}` === hash,
    );
    row?.scrollIntoView({ block: "nearest" });
    row?.focus({ preventScroll: true });
  }, [hash]);
  const only = placeParam(search.get("status"));
  const measurements = measurementsOf(workflow);
  const live = detail.inputs.some((s) => s.runs[0] && s.runs[0].state.status !== "ended");
  const now = useNow(live);
  const groups = PLACES.map((p) => ({
    ...p,
    inputs: detail.inputs.filter((s) => placeOf(s, detail.study.example) === p.place),
  })).filter((g) => g.inputs.length > 0 && (!only || g.place === only));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 max-[1099px]:flex-col max-[1099px]:overflow-y-auto">
      <div className="min-w-0 flex-1 min-[1100px]:overflow-y-auto">
        <PageHead className="border-b-0" title={detail.study.name} />
        {only && (
          <p className="m-0 flex items-baseline gap-3 px-6 text-sm text-muted-foreground">
            Showing {groups.reduce((n, g) => n + g.inputs.length, 0)} of {detail.inputs.length}{" "}
            {INPUT_WORD.many}: {PLACES.find((p) => p.place === only)?.title}.
            <Button asChild variant="link">
              <Link to="?" replace>
                Show every {INPUT_WORD.one}
              </Link>
            </Button>
          </p>
        )}
        <div className="grid gap-6 px-4 pt-2 pb-8">
          {groups.length === 0 ? (
            <p className="m-0 px-2 text-sm text-muted-foreground">
              No {INPUT_WORD.one} is here now.
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.place} aria-labelledby={`place-${g.place}`} className="grid gap-1">
                <h2
                  id={`place-${g.place}`}
                  className="m-0 flex items-center gap-2 px-2 text-sm font-semibold"
                >
                  {g.title}
                  <Count>{g.inputs.length}</Count>
                </h2>
                <ul className="m-0 grid list-none p-0">
                  {g.inputs.map((input) => (
                    <SampleRow
                      studyId={detail.study.id}
                      key={input.member.inputId}
                      input={input}
                      measurements={measurements}
                      now={now}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
        <details className="mx-6 mb-6 min-[1100px]:hidden">
          <summary className="cursor-pointer rounded-sm text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring">
            Study details
          </summary>
          <div className="grid gap-7 pt-4">
            <StudyFacts detail={detail} workflow={workflow} />
            <HeadlineBlock detail={detail} workflow={workflow} />
            <RecentActivity detail={detail} />
          </div>
        </details>
      </div>
      <div className="hidden min-h-0 min-[1100px]:flex">
        <SidePanel side="right" title="Study details" foldedLabel="details">
          <div className="grid content-start gap-7 px-4 pt-3 pb-6">
            <StudyFacts detail={detail} workflow={workflow} />
            <HeadlineBlock detail={detail} workflow={workflow} />
            <RecentActivity detail={detail} />
          </div>
        </SidePanel>
      </div>
    </div>
  );
}

function SampleRow({
  studyId,
  input,
  measurements,
  now,
}: {
  studyId: string;
  input: StudyInputDetail;
  measurements: Measurement[];
  now: number;
}) {
  const href = openHref(studyId, input);
  const changed = changedAt(input);
  const name = <span className="font-mono text-sm font-semibold">{inputLabel(input.member)}</span>;
  return (
    <li
      id={input.member.inputId}
      tabIndex={-1}
      className={cx(
        "group/row relative grid min-h-14 grid-cols-[2.5rem_minmax(0,1fr)_auto_5.5rem_1rem] items-center gap-x-4 rounded-md px-2 focus-visible:outline-2 focus-visible:outline-ring",
        href && "hover:bg-accent",
      )}
    >
      <Thumbnail src={input.runs[0] && runThumbnailUrl(input.runs[0].id)} />
      <div className="grid min-w-0 gap-0.5 py-2">
        <p className="m-0 flex min-w-0 items-baseline gap-3">
          {href ? (
            <Link
              to={href}
              className="truncate after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-ring"
            >
              {name}
            </Link>
          ) : (
            name
          )}
          <span className="truncate text-sm text-muted-foreground">{input.member.group}</span>
        </p>
        <StatusLine input={input} measurements={measurements} />
      </div>
      <span className="min-w-0">
        {hasBar(input) && <SampleBar input={input} measurements={measurements} />}
      </span>
      <span className="text-right text-sm whitespace-nowrap text-fg-subtle tabular-nums">
        {changed && whenText(changed, now)}
      </span>
      {href && <ChevronRight aria-hidden className="size-3.5 text-fg-subtle" />}
    </li>
  );
}

/**
 * The row's one line: what needs you, where a run is, how it stopped, or that it is done, naming
 * any measurement its result lacks.
 */
function StatusLine({
  input,
  measurements,
}: {
  input: StudyInputDetail;
  measurements: Measurement[];
}) {
  const run = input.runs[0];
  const status = inputStatus(input);
  let mark = <StatusMark {...status} />;
  let more: string | null = null;
  if (run && status.status === "check" && input.waiting === 0) {
    mark = <StatusMark status="check" label={toCheckText(needsYouOf(input))} />;
  } else if (run && (status.status === "running" || status.status === "checking")) {
    mark = <StatusMark {...liveStatus({ ...run, review: input.review, waiting: 0 })} />;
  } else if (status.status === "stopped") {
    // `label` is "Failed" or "Stopped", from the run's outcome.
    mark = <StatusMark status="stopped" label={`${status.label} before it finished`} />;
  } else if (status.status === "done" && hasBar(input)) {
    const missing = measurements
      .filter((o) => segmentOf(input, o) === "missing")
      .map((o) => o.name);
    if (missing.length > 0)
      more = missing.length > 2 ? `${missing.length} missing` : `${missing.join(", ")} missing`;
  }
  return (
    <span className="flex min-w-0 items-baseline gap-2 overflow-hidden text-sm">
      {mark}
      {more && (
        <span className="truncate text-muted-foreground" title={more}>
          {more}
        </span>
      )}
    </span>
  );
}
