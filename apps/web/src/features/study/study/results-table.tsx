/**
 * Measurements compared across the study's groups: one row per measurement with its strip plot
 * (every scan a dot, the group mean a tick, a scan far from its group amber), each group's mean
 * and how many scans it has a value for. A dot opens that scan's review. The dashboard shows the
 * headline measurements; Results shows every one, under its task.
 */
import type { StudyDetail, StudyScanDetail } from "@voluma/contracts/study";
import type { OutputEntry } from "@voluma/contracts/workflow-files";
import { groupNames, groupOf } from "@voluma/run-view";
import { StripPlot, Table, type TableColumn } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { useNavigate } from "react-router";
import {
  digitsFor,
  farFromGroup,
  otherUnit,
  rangeText,
  scanHref,
  scanValue,
  unitOf,
  valuesOf,
} from "./study-model";

type Measure = { output: OutputEntry; digits: number };

export function ResultsTable({
  detail,
  workflow,
  outputs,
  byTask = false,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
  outputs: OutputEntry[];
  /** Heads each task's measurements with the task's title. */
  byTask?: boolean;
}) {
  const navigate = useNavigate();
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  const groups = groupNames(detail);
  const inGroup = (g: string) => detail.scans.filter((s) => groupOf(s, grouped) === g);
  const rows: Measure[] = outputs.map((output) => ({
    output,
    digits: digitsFor(valuesOf(detail, output)),
  }));

  const columns: TableColumn<Measure>[] = [
    {
      key: "measure",
      header: "Measurement",
      cell: ({ output }) => (
        <span className="grid w-52 whitespace-normal">
          <span className="leading-snug">{output.name}</span>
          {!byTask && (
            <span className="truncate text-sm font-normal text-fg-subtle">
              {workflow.taskTitle(output.task)}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "plot",
      header: grouped ? `${groups.join(" and ")}, each dot a scan` : "Each dot a scan",
      cell: (m) => (
        <Plot
          detail={detail}
          measure={m}
          grouped={grouped}
          onOpen={(scan) => {
            const href = scanHref(scan);
            if (href) navigate(href);
          }}
        />
      ),
    },
    ...groups.map(
      (g): TableColumn<Measure> => ({
        key: `mean-${g}`,
        header: grouped ? `${g} mean` : "Mean",
        align: "end",
        cell: ({ output, digits }) => {
          const values = inGroup(g).flatMap((s) => scanValue(s, output) ?? []);
          if (values.length === 0) return <span className="text-fg-subtle">No values yet</span>;
          const mean = values.reduce((a, b) => a + b, 0) / values.length;
          return (
            <span className="font-mono text-sm whitespace-nowrap">
              {mean.toFixed(digits)}{" "}
              <span className="text-xs text-fg-subtle">{unitOf(output)}</span>
            </span>
          );
        },
      }),
    ),
    {
      key: "n",
      header: "Scans",
      align: "end",
      cell: ({ output }) => (
        <span className="font-mono text-sm whitespace-nowrap text-muted-foreground">
          {groups
            .map((g) => inGroup(g).filter((s) => scanValue(s, output) !== null).length)
            .join(" and ")}
        </span>
      ),
    },
  ];

  return (
    <Table
      label="Results by group"
      columns={columns}
      rows={rows}
      rowKey={(m) => m.output.id}
      groupOf={byTask ? (m) => workflow.taskTitle(m.output.task) : undefined}
      className="rounded-none border-x-0 border-b-0"
      rowDetail={(m) => {
        const elsewhere = detail.scans.flatMap((s) => {
          const unit = otherUnit(s, m.output);
          return unit ? [`${s.scan.subject} reported in ${unit}`] : [];
        });
        return elsewhere.length > 0 ? (
          <p className="m-0 text-sm text-muted-foreground">Not plotted: {elsewhere.join(", ")}.</p>
        ) : undefined;
      }}
    />
  );
}

/** Who a far scan is compared with: its group's other scans. */
const others = (scan: StudyScanDetail) =>
  scan.scan.group ? `other ${scan.scan.group} scans` : "other scans";

function Plot({
  detail,
  measure: { output, digits },
  grouped,
  onOpen,
}: {
  detail: StudyDetail;
  measure: Measure;
  grouped: boolean;
  onOpen: (scan: StudyScanDetail) => void;
}) {
  const unit = unitOf(output);
  const far = farFromGroup(detail, output);
  const byId = new Map(detail.scans.map((s) => [s.scan.inputId, s]));
  return (
    <StripPlot
      className="w-72"
      label={output.name}
      unit={unit}
      digits={digits}
      onSelect={(point) => {
        const scan = byId.get(point.id);
        if (scan) onOpen(scan);
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

/**
 * A scan has a dot when its value is in the declared unit, or "to come" while its run can still
 * report one. A stopped run, an output its result skipped and a value in another unit have none.
 */
const onPlot = (scan: StudyScanDetail, output: OutputEntry) =>
  scan.resultRunId !== null
    ? scanValue(scan, output) !== null
    : scan.runs[0]?.state.status !== "ended";
