/**
 * The blocks that describe one study at the side of a page: its details, one measurement compared
 * across its groups, and its recent activity. The study page's right side shows them, and so does
 * the Studies page's details pane for the selected study. Each reads only the `StudyDetail`.
 */
import type { StudyDetail, StudyInputDetail } from "@voluma/contracts/study";
import type { OutputEntry } from "@voluma/contracts/workflow-files";
import { groupNames, groupOf, inputHref, kneeOf, plural, useNow, whenText } from "@voluma/run-view";
import { Button, cx, Facts, INPUT_WORD, type Status, StatusGlyph, StripPlot } from "@voluma/ui";
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
  inputValue,
  kneeWord,
  openHref,
  rangeText,
  resultRunQuery,
  unitOf,
  valuesOf,
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
  const grouped = detail.inputs.some((s) => s.member.group !== null);
  return groupNames(detail).map((g) => {
    const inputs = detail.inputs.filter((s) => groupOf(s, grouped) === g);
    const knees = [...new Set(inputs.map(kneeOf))];
    const knee = knees.length === 1 && knees[0] ? ` · ${kneeWord(knees[0])} knees` : "";
    return grouped
      ? `${g}, ${inputs.length}${knee}`
      : `${plural(inputs.length, INPUT_WORD.one, INPUT_WORD.many)}${knee}`;
  });
}

export function StudyFacts({
  detail,
  workflow,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
}) {
  const grouped = detail.inputs.some((s) => s.member.group !== null);
  return (
    <Facts
      items={[
        [
          "Workflow",
          `${workflow.name} · ${plural(measurementsOf(workflow).length, "measurement")}`,
        ],
        [
          grouped ? "Groups" : INPUT_WORD.Many,
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
const others = (input: StudyInputDetail) =>
  input.member.group
    ? `other ${input.member.group} ${INPUT_WORD.many}`
    : `other ${INPUT_WORD.many}`;

/**
 * A sample has a dot when its value is in the declared unit, or counts as "to come" while its run
 * can still report one. A stopped run, an output its result skipped and a value in another unit
 * have none.
 */
const onPlot = (input: StudyInputDetail, output: OutputEntry) =>
  input.resultRunId !== null
    ? inputValue(input, output) !== null
    : input.runs[0] !== undefined && input.runs[0].state.status !== "ended";

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
  const grouped = detail.inputs.some((s) => s.member.group !== null);
  const unit = unitOf(output);
  const digits = digitsFor(valuesOf(detail, output));
  const far = farFromGroup(detail, output);
  const byId = new Map(detail.inputs.map((s) => [s.member.inputId, s]));
  return (
    <StripPlot
      className={className}
      label={output.name}
      unit={unit}
      digits={digits}
      onSelect={(point) => {
        const input = byId.get(point.id);
        if (!input?.runs[0]) return;
        navigate(inputHref(detail.study.id, input.member.inputId, resultRunQuery(input)));
      }}
      groups={groupNames(detail).map((group) => ({
        name: group,
        points: detail.inputs
          .filter((s) => groupOf(s, grouped) === group && onPlot(s, output))
          .map((s) => {
            const f = far.get(s.member.inputId);
            return {
              id: s.member.inputId,
              label: s.member.subject,
              value: inputValue(s, output),
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
  const others = measurementsOf(workflow).some((o) => valuesOf(detail, o).length > 0);
  return (
    <SideBlock title={output.name} aside={<span className="text-fg-subtle">{unitOf(output)}</span>}>
      {any ? (
        <MeasurePlot detail={detail} output={output} />
      ) : (
        <p className="m-0 text-sm text-muted-foreground">
          {others
            ? "No headline value yet. Other measurements have values."
            : `No values yet. Each ${INPUT_WORD.one}'s values appear when its run finishes.`}
        </p>
      )}
      {detail.inputs.length > 1 && (
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
  const live = detail.inputs.some((s) => s.runs[0] && s.runs[0].state.status !== "ended");
  // A minute is the finest step `whenText` shows.
  const now = useNow(live);
  return (
    <SideBlock title="Recent activity">
      {lines.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2.5 p-0">
          {lines.map((line) => {
            const href = openHref(detail.study.id, line.input);
            const text = (
              <>
                <span className="font-mono text-xs font-medium">{line.input.member.subject}</span>{" "}
                {line.text}
              </>
            );
            return (
              <li
                key={`${line.input.member.inputId}-${line.kind}-${line.at}`}
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
