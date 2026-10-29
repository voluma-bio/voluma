/**
 * The study's Scans tab: every scan under its group's header row, with its status and the
 * workflow's headline values (units in the column heads; a value far from its group says so with
 * its group's range; one in another unit says which). A row opens the scan's run; a scan with no
 * run yet starts one from here (`POST /api/run/runs`).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, startRun } from "@voluma/api-client";
import type { StudyDetail, StudyScanDetail } from "@voluma/contracts/study";
import { Button, StatusBadge, Table, type TableColumn } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { useNavigate } from "react-router";
import {
  digitsFor,
  farFromGroup,
  groupNames,
  groupOf,
  kneeOf,
  otherUnit,
  rangeText,
  scanHref,
  scanStatus,
  scanValue,
  unitOf,
  valuesOf,
} from "./study-model";

export function ScansTable({
  detail,
  workflow,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
}) {
  const navigate = useNavigate();
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  const rows = groupNames(detail).flatMap((g) =>
    detail.scans.filter((s) => groupOf(s, grouped) === g),
  );
  const valueColumns = workflow.headline.map((output): TableColumn<StudyScanDetail> => {
    const digits = digitsFor(valuesOf(detail, output));
    const far = farFromGroup(detail, output);
    const unit = unitOf(output);
    return {
      key: output.id,
      align: "end",
      // Long names wrap in a fixed width so the column stays narrow on a phone.
      header: (
        <span className="inline-block w-40 whitespace-normal">
          {output.name}
          {unit && <span className="whitespace-nowrap">, {unit}</span>}
        </span>
      ),
      cell: (s) => {
        const other = otherUnit(s, output);
        if (other)
          return (
            <span className="text-meta text-muted-foreground">
              <span className="font-mono">{s.values[output.id]?.value}</span> reported in {other}
            </span>
          );
        const value = scanValue(s, output);
        if (value === null) return <span className="text-fg-subtle">–</span>;
        const f = far.get(s.scan.inputId);
        if (!f) return <span className="font-mono">{value.toFixed(digits)}</span>;
        return (
          <span className="grid justify-items-end">
            <span className="font-mono font-medium text-check">{value.toFixed(digits)}</span>
            <span className="text-meta text-check">
              Far from group ({rangeText(f.others, digits)})
            </span>
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
      key: "knee",
      header: "Knee",
      cell: (s) => kneeOf(s) ?? <span className="text-fg-subtle">–</span>,
    },
    { key: "status", header: "Status", cell: (s) => <ScanStatusCell detail={detail} scan={s} /> },
    ...valueColumns,
  ];
  return (
    <Table
      label="Scans"
      columns={columns}
      rows={rows}
      rowKey={(s) => s.scan.inputId}
      groupOf={
        grouped
          ? (s) => {
              const g = groupOf(s, grouped);
              const n = rows.filter((r) => groupOf(r, grouped) === g).length;
              return `${g}, ${n} ${n === 1 ? "scan" : "scans"}`;
            }
          : undefined
      }
      onRowClick={(s) => {
        const path = scanHref(s);
        if (path) navigate(path);
      }}
      className="[&_td]:align-middle [&_td]:whitespace-nowrap [&_th]:align-bottom [&_th]:whitespace-nowrap"
    />
  );
}

function ScanStatusCell({ detail, scan }: { detail: StudyDetail; scan: StudyScanDetail }) {
  const client = useQueryClient();
  const start = useMutation({
    mutationFn: () => startRun({ studyId: detail.study.id, inputId: scan.scan.inputId }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["study"] }),
  });
  const { label, tone, progress } = scanStatus(scan);
  if (scan.runs.length > 0)
    return (
      <span className="flex items-center gap-2">
        <StatusBadge tone={tone}>{label}</StatusBadge>
        {progress && <span className="text-meta text-fg-subtle tabular-nums">{progress}</span>}
      </span>
    );
  return (
    <span className="grid gap-1">
      <span className="flex items-center gap-2">
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
      </span>
      {start.isError && (
        <span role="alert" className="text-meta whitespace-normal text-destructive">
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
