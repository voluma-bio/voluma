/**
 * The study's Scans page: every scan under its group with its status, its tasks (one Progress
 * cell per task) and the workflow's headline values (units in the cells; a value far from its
 * group in amber, with its group's range on hover). A row opens the scan's review; its chevron
 * opens the scan's tasks at summary size. A scan with no run yet starts one from here.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, startRun } from "@voluma/api-client";
import { allStudiesKey } from "@voluma/api-client/query";
import type { VisitorKeys } from "@voluma/contracts/run";
import type { StudyDetail, StudyScanDetail } from "@voluma/contracts/study";
import { groupNames, groupOf, loadKeys, RunKeyLine, scanStatus, TaskGraph } from "@voluma/run-view";
import {
  Button,
  Count,
  type Density,
  PageHead,
  Progress,
  SegmentedControl,
  StatusMark,
  Table,
  type TableColumn,
} from "@voluma/ui";
import { useState } from "react";
import { linkTo } from "../link";
import { useStudy } from "./study-layout";
import {
  cellOf,
  checkTitles,
  digitsFor,
  farFromGroup,
  otherUnit,
  rangeText,
  scanGraph,
  scanHref,
  scanName,
  scanValue,
  stoppedLine,
  unitOf,
  valuesOf,
} from "./study-model";

export function ScansPage() {
  const { detail, workflow, me } = useStudy();
  const [density, setDensity] = useState<Density>("comfortable");
  const [keys, setKeys] = useState<VisitorKeys | undefined>(() => loadKeys(me.userId));
  const guest = me.kind === "visitor";
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  const rows = groupNames(detail).flatMap((g) =>
    detail.scans.filter((s) => groupOf(s, grouped) === g),
  );

  /** What a scan's row says under its name: what waits, or where it stopped. */
  const line = (s: StudyScanDetail) => {
    if (s.toCheck.length > 0) return checkTitles(s.toCheck);
    const stopped = stoppedLine(s, workflow);
    if (stopped) return stopped;
    if (s.runs.length === 0) return "Not started";
    return s.resultRunId ? "Nothing to check" : undefined;
  };

  const valueColumns = workflow.headline.map((output): TableColumn<StudyScanDetail> => {
    const digits = digitsFor(valuesOf(detail, output));
    const far = farFromGroup(detail, output);
    const unit = unitOf(output);
    return {
      key: output.id,
      align: "end",
      header: <span className="inline-block w-28 whitespace-normal">{output.name}</span>,
      cell: (s) => {
        const other = otherUnit(s, output);
        if (other)
          return (
            <span className="text-sm text-muted-foreground">
              <span className="font-mono">{s.values[output.id]?.value}</span> {other}
            </span>
          );
        const value = scanValue(s, output);
        if (value === null) return null;
        const f = far.get(s.scan.inputId);
        return (
          <span
            title={
              f && `Far from its group: the others measure ${rangeText(f.others, digits)} ${unit}`
            }
            className="font-mono text-sm whitespace-nowrap"
          >
            <span className={f ? "font-semibold text-check" : undefined}>
              {value.toFixed(digits)}
            </span>{" "}
            <span className="text-xs text-fg-subtle">{unit}</span>
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
        <span className="grid w-44">
          <span className="truncate">{scanName(s)}</span>
          {density === "comfortable" && (
            <span className="truncate text-sm font-normal text-fg-subtle">{line(s)}</span>
          )}
        </span>
      ),
    },
    ...(grouped
      ? [
          {
            key: "group",
            header: "Group",
            cell: (s: StudyScanDetail) => <span className="text-sm">{s.scan.group}</span>,
          },
        ]
      : []),
    {
      key: "status",
      header: "Status",
      cell: (s) => <ScanStatusCell detail={detail} scan={s} keys={keys} guest={guest} />,
    },
    {
      key: "tasks",
      header: "Tasks",
      cell: (s) => (
        <Progress states={workflow.tasks.map((t) => cellOf(s, t.id).status)} className="w-24" />
      ),
    },
    ...valueColumns,
  ];

  const canStart = !detail.study.example && detail.scans.some((s) => s.runs.length === 0);
  return (
    <>
      <PageHead title="Scans" count={<Count>{detail.scans.length}</Count>} />
      <section aria-labelledby="all-scans">
        <header className="flex h-(--panel-head-h) items-center gap-3 px-4">
          <h2 id="all-scans" className="m-0 text-sm font-semibold">
            All scans
          </h2>
          <SegmentedControl<Density>
            label="Rows"
            className="ml-auto"
            value={density}
            onValueChange={setDensity}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </header>
        <Table
          label="Scans"
          density={density}
          columns={columns}
          rows={rows}
          rowKey={(s) => s.scan.inputId}
          groupOf={grouped ? (s) => groupOf(s, grouped) : undefined}
          rowLink={(s) => {
            const href = scanHref(s);
            return href ? linkTo(href) : undefined;
          }}
          rowDetail={(s) =>
            s.runs.length > 0 ? (
              <div className="overflow-x-auto py-2">
                <TaskGraph
                  size="summary"
                  tasks={scanGraph(s, workflow)}
                  className="min-w-[40rem]"
                />
              </div>
            ) : undefined
          }
          className="rounded-none border-x-0 border-b-0 [&_td]:whitespace-nowrap"
        />
      </section>
      {/* Starting a scan runs on a key; the line sits after the scans it starts, not over them. */}
      {canStart && (
        <div className="border-t border-border px-6 py-4">
          <div className="max-w-md">
            <RunKeyLine userId={me.userId} guest={guest} keys={keys} onChange={setKeys} />
          </div>
        </div>
      )}
    </>
  );
}

function ScanStatusCell({
  detail,
  scan,
  keys,
  guest,
}: {
  detail: StudyDetail;
  scan: StudyScanDetail;
  keys: VisitorKeys | undefined;
  guest: boolean;
}) {
  const client = useQueryClient();
  const start = useMutation({
    mutationFn: () => startRun({ studyId: detail.study.id, inputId: scan.scan.inputId, keys }),
    onSuccess: () => client.invalidateQueries({ queryKey: allStudiesKey }),
  });
  const { label, status } = scanStatus(scan);
  if (scan.runs.length > 0) return <StatusMark status={status} label={label} />;
  return (
    <span className="grid gap-1">
      <Button
        size="sm"
        disabled={start.isPending || start.isSuccess || detail.study.example || (guest && !keys)}
        reason={guest && !keys && !detail.study.example ? "Add your Meta key first." : undefined}
        onClick={() => start.mutate()}
      >
        {start.isPending || start.isSuccess ? "Starting…" : "Start"}
      </Button>
      {start.isError && (
        <span role="alert" className="text-sm whitespace-normal text-destructive">
          {startError(start.error)}
        </span>
      )}
    </span>
  );
}

function startError(error: Error): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return error.serverMessage ?? "Example studies are read-only.";
    if (error.status === 409) return "You already have a run going. Start this after it finishes.";
    if (error.status === 429) return "The lab's run limit is reached. Try again later.";
    if (error.status === 404) return "This scan is no longer available.";
  }
  return "Couldn't start the run. Try again.";
}
