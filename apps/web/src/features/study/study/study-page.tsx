/**
 * A study's page (`/studies/:id`): which sample needs me. Its samples grouped Needs you, Running,
 * Done (then Not started), each row with its picture, group and knee, its bar of measurements,
 * one line of status and when it last changed; a row opens the input review at the first item that
 * needs you, else the input. `?status=<place>` shows one group. On the right: the study's details,
 * its headline measurement with the way to Compare, and recent activity. Nothing here judges or
 * changes a result.
 */
import { runThumbnailUrl } from "@voluma/api-client";
import type { StudyInputDetail } from "@voluma/contracts/study";
import {
  inputStatus,
  kneeOf,
  liveStatus,
  needsYouOf,
  needsYouText,
  plural,
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
} from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { ChevronRight, PanelRight } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { SampleBar } from "./sample-bar";
import { useStudy } from "./study-layout";
import {
  actHref,
  changedAt,
  hasBar,
  kneeWord,
  openHref,
  PLACES,
  type Place,
  placeOf,
  placeParam,
  reviewHref,
  type Section,
  sectionsOf,
  segmentOf,
  stoppedLine,
  waitsOn,
} from "./study-model";
import { HeadlineBlock, RecentActivity, SideBlock, StudyFacts } from "./study-side";

export function StudyPage() {
  const { detail, workflow } = useStudy();
  const [search] = useSearchParams();
  const only = placeParam(search.get("status"));
  const sections = sectionsOf(workflow);
  const live = detail.inputs.some((s) => s.runs[0] && s.runs[0].state.status !== "ended");
  const now = useNow(live);
  const knees = detail.inputs.some((s) => kneeOf(s) !== null);
  const groups = PLACES.map((p) => ({
    ...p,
    inputs: detail.inputs.filter((s) => placeOf(s, detail.study.example) === p.place),
  })).filter((g) => g.inputs.length > 0 && (!only || g.place === only));

  return (
    <>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <PageHead
          className="border-b-0 bg-transparent"
          title={detail.study.name}
          subtitle={`${workflow.name} · ${plural(detail.inputs.length, INPUT_WORD.one, INPUT_WORD.many)}`}
        />
        {only && (
          <p className="m-0 flex items-baseline gap-3 px-6 text-sm text-muted-foreground">
            Showing only {PLACES.find((p) => p.place === only)?.title}.
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
                      place={g.place}
                      workflow={workflow}
                      sections={sections}
                      knees={knees}
                      now={now}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
      <SidePanel side="right" title="Study" icon={<PanelRight />}>
        <div className="grid content-start gap-7 px-4 pt-3 pb-6">
          <SideBlock title="Study details">
            <StudyFacts detail={detail} workflow={workflow} />
          </SideBlock>
          <HeadlineBlock detail={detail} workflow={workflow} />
          <RecentActivity detail={detail} />
        </div>
      </SidePanel>
    </>
  );
}

function SampleRow({
  studyId,
  input,
  place,
  workflow,
  sections,
  knees,
  now,
}: {
  studyId: string;
  input: StudyInputDetail;
  place: Place;
  workflow: BundledWorkflow;
  sections: Section[];
  knees: boolean;
  now: number;
}) {
  const href = actHref(studyId, input, place);
  const knee = kneeOf(input);
  const changed = changedAt(input);
  const about = [input.member.group, knees && knee ? `${kneeWord(knee)} knee` : null]
    .filter(Boolean)
    .join(" · ");
  const name = <span className="font-mono text-sm font-semibold">{input.member.subject}</span>;
  return (
    <li
      className={cx(
        "group/row relative grid min-h-14 grid-cols-[2.5rem_minmax(0,1fr)_auto_5.5rem_1rem] items-center gap-x-4 rounded-md px-2",
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
          <span className="truncate text-sm text-muted-foreground">{about}</span>
        </p>
        <StatusLine input={input} workflow={workflow} sections={sections} />
      </div>
      <span className="min-w-0">
        {hasBar(input) && <SampleBar input={input} sections={sections} />}
      </span>
      <span className="text-right text-sm whitespace-nowrap text-fg-subtle tabular-nums">
        {changed && whenText(changed, now)}
      </span>
      {href && <ChevronRight aria-hidden className="size-3.5 text-fg-subtle" />}
    </li>
  );
}

/**
 * The row's one line: what needs you (count and the items' titles), where a run is, how it
 * stopped, or that it is done, naming any measurement its result lacks.
 */
function StatusLine({
  input,
  workflow,
  sections,
}: {
  input: StudyInputDetail;
  workflow: BundledWorkflow;
  sections: Section[];
}) {
  const run = input.runs[0];
  const status = inputStatus(input);
  let mark = <StatusMark {...status} />;
  let more: string | null = null;
  if (run && status.status === "check" && input.waiting === 0) {
    mark = <StatusMark status="check" label={needsYouText(needsYouOf(input), run.harness)} />;
    more = waitsOn(input, workflow) || null;
  } else if (run && (status.status === "running" || status.status === "checking")) {
    mark = <StatusMark {...liveStatus(run)} />;
  } else if (status.status === "stopped") {
    more = stoppedLine(input, workflow);
  } else if (status.status === "done" && hasBar(input)) {
    const missing = sections
      .flatMap((s) => s.outputs)
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
