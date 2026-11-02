/**
 * A study's page (`/studies/:id`): which sample needs me. Its samples grouped Needs you, Running,
 * Done (then Not started), each row with its picture, group and knee, its bar of measurements,
 * one line of status and when it last changed; a row opens the scan review at the first item that
 * needs you, else the scan. `?status=<place>` shows one group. On the right: the study's details,
 * its headline measurement with the way to Compare, and recent activity. Nothing here judges or
 * changes a result.
 */
import { runThumbnailUrl } from "@voluma/api-client";
import type { StudyScanDetail } from "@voluma/contracts/study";
import { kneeOf, liveStatus, needsYouOf, plural, scanStatus, useNow } from "@voluma/run-view";
import { Button, Count, cx, PageHead, SidePanel, StatusMark, Thumbnail } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { ChevronRight, PanelRight } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { SampleBar } from "./sample-bar";
import { useStudy } from "./study-layout";
import {
  changedAt,
  hasBar,
  kneeWord,
  PLACES,
  placeOf,
  placeParam,
  reviewHref,
  type Section,
  scanHref,
  sectionsOf,
  segmentOf,
  stoppedLine,
  waitsOn,
  whenText,
} from "./study-model";
import { HeadlineBlock, RecentActivity, SideBlock, StudyFacts } from "./study-side";

export function StudyPage() {
  const { detail, workflow } = useStudy();
  const [search] = useSearchParams();
  const only = placeParam(search.get("status"));
  const sections = sectionsOf(workflow);
  const live = detail.scans.some((s) => s.runs[0] && s.runs[0].state.status !== "ended");
  const now = useNow(live);
  const knees = detail.scans.some((s) => kneeOf(s) !== null);
  const groups = PLACES.map((p) => ({
    ...p,
    scans: detail.scans.filter((s) => placeOf(s) === p.place),
  })).filter((g) => g.scans.length > 0 && (!only || g.place === only));

  return (
    <>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <PageHead
          className="border-b-0 bg-transparent"
          title={detail.study.name}
          subtitle={`${workflow.name} · ${plural(detail.scans.length, "sample")}`}
        />
        {only && (
          <p className="m-0 flex items-baseline gap-3 px-6 text-sm text-muted-foreground">
            Showing only {PLACES.find((p) => p.place === only)?.title}.
            <Button asChild variant="link">
              <Link to="?" replace>
                Show every sample
              </Link>
            </Button>
          </p>
        )}
        <div className="grid gap-6 px-4 pt-2 pb-8">
          {groups.length === 0 ? (
            <p className="m-0 px-2 text-sm text-muted-foreground">No sample is here now.</p>
          ) : (
            groups.map((g) => (
              <section key={g.place} aria-labelledby={`place-${g.place}`} className="grid gap-1">
                <h2
                  id={`place-${g.place}`}
                  className="m-0 flex items-center gap-2 px-2 text-sm font-semibold"
                >
                  {g.title}
                  <Count>{g.scans.length}</Count>
                </h2>
                <ul className="m-0 grid list-none p-0">
                  {g.scans.map((scan) => (
                    <SampleRow
                      key={scan.scan.inputId}
                      scan={scan}
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
  scan,
  workflow,
  sections,
  knees,
  now,
}: {
  scan: StudyScanDetail;
  workflow: BundledWorkflow;
  sections: Section[];
  knees: boolean;
  now: number;
}) {
  const href = placeOf(scan) === "needs-you" ? reviewHref(scan) : scanHref(scan);
  const knee = kneeOf(scan);
  const changed = changedAt(scan);
  const about = [scan.scan.group, knees && knee ? `${kneeWord(knee)} knee` : null]
    .filter(Boolean)
    .join(" · ");
  const name = <span className="font-mono text-sm font-semibold">{scan.scan.subject}</span>;
  return (
    <li
      className={cx(
        "group/row relative grid min-h-14 grid-cols-[2.5rem_10rem_7rem_auto_minmax(0,1fr)_5.5rem_1rem] items-center gap-x-4 rounded-md px-2",
        href && "hover:bg-accent",
      )}
    >
      <Thumbnail src={scan.runs[0] && runThumbnailUrl(scan.runs[0].id)} />
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
      <span className="min-w-0">
        {hasBar(scan) && <SampleBar scan={scan} sections={sections} />}
      </span>
      <StatusLine scan={scan} workflow={workflow} sections={sections} />
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
  scan,
  workflow,
  sections,
}: {
  scan: StudyScanDetail;
  workflow: BundledWorkflow;
  sections: Section[];
}) {
  const run = scan.runs[0];
  const status = scanStatus(scan);
  let mark = <StatusMark {...status} />;
  let more: string | null = null;
  if (run && status.status === "check") {
    mark = <StatusMark status="check" label={`${needsYouOf(scan)} to check`} />;
    more = waitsOn(scan, workflow) || null;
  } else if (run && (status.status === "running" || status.status === "checking")) {
    mark = <StatusMark {...liveStatus(run)} />;
  } else if (status.status === "stopped") {
    more = stoppedLine(scan, workflow);
  } else if (status.status === "done" && hasBar(scan)) {
    const missing = sections
      .flatMap((s) => s.outputs)
      .filter((o) => segmentOf(scan, o) === "missing")
      .map((o) => o.name);
    if (missing.length > 0)
      more = missing.length > 2 ? `${missing.length} missing` : `${missing.join(", ")} missing`;
  }
  return (
    <span className="flex min-w-0 items-baseline gap-2 text-sm">
      {mark}
      {more && (
        <span className="truncate text-muted-foreground" title={more}>
          {more}
        </span>
      )}
    </span>
  );
}
