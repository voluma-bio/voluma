/**
 * The blocks that describe one study at the side of a page: its details, one measurement compared
 * across its groups, and its recent activity. The study page's right side shows them, and so does
 * the Studies page's details pane for the selected study. Each reads only the `StudyDetail`.
 */
import type { StudyDetail, StudyScanDetail } from "@voluma/contracts/study";
import type { OutputEntry } from "@voluma/contracts/workflow-files";
import { groupNames, groupOf, kneeOf, plural, useNow } from "@voluma/run-view";
import { Button, cx, Facts, type Status, StatusGlyph, StripPlot } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { measurementsOf } from "../workflow-tasks";
import {
  type Activity,
  activityOf,
  digitsFor,
  farFromGroup,
  kneeWord,
  rangeText,
  scanHref,
  scanValue,
  unitOf,
  valuesOf,
  whenText,
} from "./study-model";

/** A block of the side: a plain heading (with an optional count or link), then its content. */
export function SideBlock({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2.5">
      <header className="flex items-baseline gap-2">
        <h3 className="m-0 text-sm font-semibold">{title}</h3>
        {aside && <span className="ml-auto text-sm">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

/** "OA, 5 · right knees": a group, its size and, when they share one, its samples' knee. */
function groupLines(detail: StudyDetail): string[] {
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  return groupNames(detail).map((g) => {
    const scans = detail.scans.filter((s) => groupOf(s, grouped) === g);
    const knees = [...new Set(scans.map(kneeOf))];
    const knee = knees.length === 1 && knees[0] ? ` · ${kneeWord(knees[0])} knees` : "";
    return grouped ? `${g}, ${scans.length}${knee}` : `${plural(scans.length, "sample")}${knee}`;
  });
}

export function StudyFacts({
  detail,
  workflow,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
}) {
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  return (
    <Facts
      items={[
        [
          "Workflow",
          `${workflow.name} · ${plural(measurementsOf(workflow).length, "measurement")}`,
        ],
        [
          grouped ? "Groups" : "Samples",
          <span key="g" className="grid">
            {groupLines(detail).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>,
        ],
        [
          "Created",
          new Date(detail.study.createdAt).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          }),
        ],
        ...(detail.study.example
          ? [
              ["Example", "Shared with every lab: you can look but not change it."] as [
                string,
                string,
              ],
            ]
          : []),
      ]}
    />
  );
}

/** Who a far sample is compared with: its group's other samples. */
const others = (scan: StudyScanDetail) =>
  scan.scan.group ? `other ${scan.scan.group} samples` : "other samples";

/**
 * A sample has a dot when its value is in the declared unit, or counts as "to come" while its run
 * can still report one. A stopped run, an output its result skipped and a value in another unit
 * have none.
 */
const onPlot = (scan: StudyScanDetail, output: OutputEntry) =>
  scan.resultRunId !== null
    ? scanValue(scan, output) !== null
    : scan.runs[0] !== undefined && scan.runs[0].state.status !== "ended";

/** One measurement across the study's groups: every sample a dot, a dot opens its sample. */
export function MeasurePlot({
  detail,
  output,
  className,
}: {
  detail: StudyDetail;
  output: OutputEntry;
  className?: string;
}) {
  const navigate = useNavigate();
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  const unit = unitOf(output);
  const digits = digitsFor(valuesOf(detail, output));
  const far = farFromGroup(detail, output);
  const byId = new Map(detail.scans.map((s) => [s.scan.inputId, s]));
  return (
    <StripPlot
      className={className}
      label={output.name}
      unit={unit}
      digits={digits}
      onSelect={(point) => {
        const scan = byId.get(point.id);
        const href = scan && scanHref(scan);
        if (href) navigate(href);
      }}
      groups={groupNames(detail).map((group) => ({
        name: group,
        points: detail.scans
          .filter((s) => groupOf(s, grouped) === group && onPlot(s, output))
          .map((s) => {
            const f = far.get(s.scan.inputId);
            return {
              id: s.scan.inputId,
              label: s.scan.subject,
              value: scanValue(s, output),
              far: f !== undefined,
              farReason: f && `The ${others(s)} measure ${rangeText(f.others, digits)} ${unit}`,
            };
          }),
      }))}
    />
  );
}

/** The study's headline measurement (the workflow's first), with the way to every comparison. */
export function HeadlineBlock({
  detail,
  workflow,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
}) {
  const output = workflow.headline[0] ?? measurementsOf(workflow)[0];
  if (!output) return null;
  const any = valuesOf(detail, output).length > 0;
  return (
    <SideBlock title={output.name} aside={<span className="text-fg-subtle">{unitOf(output)}</span>}>
      {any ? (
        <MeasurePlot detail={detail} output={output} />
      ) : (
        <p className="m-0 text-sm text-muted-foreground">
          No values yet. Each sample's appear when its run finishes.
        </p>
      )}
      {detail.scans.length > 1 && (
        <Button asChild variant="link" className="justify-self-start">
          <Link to={`/studies/${detail.study.id}/compare`}>
            Compare results
            <ChevronRight aria-hidden />
          </Link>
        </Button>
      )}
    </SideBlock>
  );
}

const ACTIVITY_MARK: Record<Activity["kind"], Status> = {
  added: "waiting",
  started: "running",
  completed: "done",
  failed: "stopped",
  stopped: "stopped",
  reviewed: "done",
};

/** The study's latest run events, each opening its sample. */
export function RecentActivity({ detail, limit = 6 }: { detail: StudyDetail; limit?: number }) {
  const lines = activityOf(detail).slice(0, limit);
  const live = detail.scans.some((s) => s.runs[0] && s.runs[0].state.status !== "ended");
  // A minute is the finest step `whenText` shows.
  const now = useNow(live);
  return (
    <SideBlock title="Recent activity">
      {lines.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2.5 p-0">
          {lines.map((line) => {
            const href = scanHref(line.scan);
            const text = (
              <>
                <span className="font-mono text-xs font-medium">{line.scan.scan.subject}</span>{" "}
                {line.text}
              </>
            );
            return (
              <li
                key={`${line.scan.scan.inputId}-${line.kind}-${line.at}`}
                className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-x-2 text-sm"
              >
                <StatusGlyph status={ACTIVITY_MARK[line.kind]} className="mt-0.5" />
                {href ? (
                  <Link to={href} className={cx("min-w-0 rounded-sm hover:underline")}>
                    {text}
                  </Link>
                ) : (
                  <span className="min-w-0">{text}</span>
                )}
                <span className="text-xs whitespace-nowrap text-fg-subtle tabular-nums">
                  {whenText(line.at, now)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SideBlock>
  );
}
