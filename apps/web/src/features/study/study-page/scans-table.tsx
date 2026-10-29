/**
 * The study's Scans tab: every scan in study order with its status and the workflow's headline
 * values (units in the column heads). A row opens the scan's run; a scan with no run yet starts
 * one from here (`POST /api/run/runs`).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, startRun } from "@voluma/api-client";
import type { StudyDetail, StudyScanDetail } from "@voluma/contracts/study";
import { Button, StatusBadge, Table, type TableColumn } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { useNavigate } from "react-router";
import { digitsFor, farFromGroup, runPath, scanStatus, scanValue, valuesOf } from "./study-model";

export function ScansTable({
  detail,
  workflow,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
}) {
  const navigate = useNavigate();
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  const valueColumns = workflow.headline.map((output): TableColumn<StudyScanDetail> => {
    const digits = digitsFor(valuesOf(detail, output.id));
    const far = farFromGroup(detail, output.id);
    const unit = "unit" in output && typeof output.unit === "string" ? output.unit : "";
    return {
      key: output.id,
      align: "end",
      header: (
        <>
          {output.name}
          {unit && <span className="whitespace-nowrap">, {unit}</span>}
        </>
      ),
      cell: (s) => {
        const value = scanValue(s, output.id);
        if (value === null) return <span className="text-fg-subtle">–</span>;
        const isFar = far.has(s.scan.inputId);
        return (
          <span
            className={`font-mono ${isFar ? "font-medium text-check" : ""}`}
            title={isFar ? "Far from its group" : undefined}
          >
            {value.toFixed(digits)}
            {isFar && <span className="sr-only">, far from its group</span>}
          </span>
        );
      },
    };
  });
  const columns: TableColumn<StudyScanDetail>[] = [
    {
      key: "scan",
      header: "Scan",
      cell: (s) => <span className="font-mono">{s.scan.subject}</span>,
    },
    {
      key: "side",
      header: "Side",
      cell: (s) =>
        typeof s.scan.attributes.side === "string" ? (
          s.scan.attributes.side
        ) : (
          <span className="text-fg-subtle">–</span>
        ),
    },
    ...(grouped
      ? [
          {
            key: "group",
            header: "Group",
            cell: (s: StudyScanDetail) => s.scan.group ?? <span className="text-fg-subtle">–</span>,
          },
        ]
      : []),
    { key: "status", header: "Status", cell: (s) => <ScanStatusCell detail={detail} scan={s} /> },
    ...valueColumns,
  ];
  return (
    <Table
      label="Scans"
      columns={columns}
      rows={detail.scans}
      rowKey={(s) => s.scan.inputId}
      onRowClick={(s) => {
        const path = runPath(s);
        if (path) navigate(path);
      }}
      className="[&_td]:align-middle [&_th]:align-bottom"
    />
  );
}

function ScanStatusCell({ detail, scan }: { detail: StudyDetail; scan: StudyScanDetail }) {
  const client = useQueryClient();
  const start = useMutation({
    mutationFn: () => startRun({ studyId: detail.study.id, inputId: scan.scan.inputId }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["study"] }),
  });
  const { label, tone } = scanStatus(scan);
  if (scan.runs.length > 0) return <StatusBadge tone={tone}>{label}</StatusBadge>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusBadge tone={tone}>{label}</StatusBadge>
      <Button
        size="sm"
        className="-my-1 h-7 px-2.5"
        disabled={start.isPending || start.isSuccess || detail.study.example}
        onClick={(event) => {
          // The row opens the run; this cell's button starts one.
          event.stopPropagation();
          start.mutate();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {start.isPending || start.isSuccess ? "Starting…" : "Start"}
      </Button>
      {start.isError && (
        <span role="alert" className="basis-full text-meta text-destructive">
          {startError(start.error)}
        </span>
      )}
    </span>
  );
}

function startError(error: Error): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Example studies are read-only.";
    if (error.status === 409) return "You already have a run going. Start this after it finishes.";
    if (error.status === 429) return "The lab's run limit is reached. Try again later.";
    if (error.status === 404) return "This scan is no longer available.";
  }
  return "Couldn't start the run. Try again.";
}
