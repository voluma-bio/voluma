/**
 * Every scan, every task: one row per scan under its group, one column per task, and the scan's
 * status last. A cell is one task of one scan: its state (with the number to check), or with
 * Values on, the task's key value (its headline measurement, else its first), underlined amber
 * while the task has items to check. A row opens the scan's review.
 */
import type { StudyDetail, StudyScanDetail } from "@voluma/contracts/study";
import { groupOf, scanStatus } from "@voluma/run-view";
import {
  cx,
  SegmentedControl,
  STATUS_WORD,
  type Status,
  StatusGlyph,
  StatusMark,
  Table,
  type TableColumn,
} from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { useState } from "react";
import { linkTo } from "../link";
import { cellOf, digitsFor, keyOutput, scanHref, scanValue, unitOf, valuesOf } from "./study-model";

type Mode = "status" | "values";

/** A cell's look per state, from the state colours; waiting is an empty outline. */
const CELL: Record<Status, string> = {
  done: "bg-done-tint text-done",
  check: "bg-check-solid text-check-solid-fg font-medium",
  running: "inset-ring-[1.5px] inset-ring-info-solid text-info",
  checking: "inset-ring-[1.5px] inset-ring-info-solid text-info",
  waiting: "inset-ring inset-ring-line-strong",
  paused: "inset-ring inset-ring-line-strong text-fg-subtle",
  stopped: "bg-destructive-solid text-destructive-solid-fg",
};

export function MatrixCell({ status, open }: { status: Status; open: number }) {
  const word = status === "check" ? `${open} to check` : STATUS_WORD[status];
  return (
    <span
      role="img"
      aria-label={word}
      title={word}
      className={cx(
        "inline-grid h-3.5 w-5.5 place-items-center rounded-[3px] font-mono text-[10px] leading-none",
        CELL[status],
      )}
    >
      {status === "check" ? (
        open
      ) : status === "done" ? (
        <i className="block h-px w-2 bg-current" />
      ) : status === "waiting" ? null : (
        <StatusGlyph status={status} className="size-2.5" />
      )}
    </span>
  );
}

export function ScanMatrix({
  detail,
  workflow,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
}) {
  const [mode, setMode] = useState<Mode>("status");
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  const taskColumns = workflow.tasks.map((task): TableColumn<StudyScanDetail> => {
    const output = keyOutput(workflow, task.id);
    const digits = output ? digitsFor(valuesOf(detail, output)) : 0;
    return {
      key: task.id,
      align: mode === "values" ? "end" : "start",
      header: (
        <span className="grid max-w-16 min-w-14 justify-items-center text-center leading-tight whitespace-normal">
          {workflow.taskTitle(task.id)}
          {mode === "values" && output && (
            <span title={output.name} className="font-mono text-[10px] text-fg-subtle">
              {unitOf(output) || "value"}
            </span>
          )}
        </span>
      ),
      cell: (scan) => {
        const cell = cellOf(scan, task.id);
        const value = output && scanValue(scan, output);
        if (mode === "values" && output && value != null)
          return (
            <span
              title={output.name}
              className={cx(
                "block text-center font-mono text-sm",
                cell.open > 0 && "underline decoration-check-solid decoration-2 underline-offset-3",
              )}
            >
              {value.toFixed(digits)}
            </span>
          );
        return (
          <span className="flex justify-center">
            <MatrixCell {...cell} />
          </span>
        );
      },
    };
  });
  const columns: TableColumn<StudyScanDetail>[] = [
    {
      key: "scan",
      header: "Scan",
      cell: (s) => (
        <span className="font-mono text-sm font-normal whitespace-nowrap">{s.scan.subject}</span>
      ),
    },
    ...taskColumns,
    {
      key: "status",
      header: "Status",
      cell: (s) => {
        const { label, status } = scanStatus(s);
        return <StatusMark status={status} label={label} />;
      },
    },
  ];
  return (
    <section aria-labelledby="matrix" className="border-b border-border">
      <header className="flex h-(--panel-head-h) items-center gap-3 px-4">
        <h2 id="matrix" className="m-0 text-sm font-semibold">
          Every scan, every task
        </h2>
        <SegmentedControl<Mode>
          label="Cells show"
          className="ml-auto"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "status", label: "Status" },
            { value: "values", label: "Values" },
          ]}
        />
      </header>
      <Table
        label="Every scan, every task"
        density="compact"
        columns={columns}
        rows={detail.scans}
        rowKey={(s) => s.scan.inputId}
        groupOf={grouped ? (s) => groupOf(s, grouped) : undefined}
        rowLink={(s) => {
          const href = scanHref(s);
          return href ? linkTo(href) : undefined;
        }}
        className="rounded-none border-x-0 border-b-0"
      />
      {mode === "status" && <Legend />}
    </section>
  );
}

const LEGEND: { status: Status; open: number }[] = [
  { status: "done", open: 0 },
  { status: "check", open: 1 },
  { status: "running", open: 0 },
  { status: "waiting", open: 0 },
  { status: "paused", open: 0 },
  { status: "stopped", open: 0 },
];

function Legend() {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 border-t border-border px-4 py-2 text-xs text-muted-foreground">
      {LEGEND.map((l) => (
        <li key={l.status} className="flex items-center gap-1.5">
          <MatrixCell {...l} />
          {STATUS_WORD[l.status]}
        </li>
      ))}
    </ul>
  );
}
