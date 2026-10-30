/**
 * The study's Results: every measurement of the workflow, by group (a strip plot per measurement
 * under its task) or as every value (one row per measurement, one column per scan, a value far
 * from its group in amber). "Export values" downloads the same table as CSV, one row per scan.
 */
import type { StudyDetail, StudyScanDetail } from "@voluma/contracts/study";
import type { OutputEntry } from "@voluma/contracts/workflow-files";
import { groupNames, groupOf, kneeOf } from "@voluma/run-view";
import {
  Button,
  cx,
  EmptyState,
  PageHead,
  SegmentedControl,
  Table,
  type TableColumn,
} from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { Download } from "lucide-react";
import { useSearchParams } from "react-router";
import { ResultsTable } from "./results-table";
import { useStudy } from "./study-layout";
import { digitsFor, farFromGroup, scanValue, unitOf, valuesOf } from "./study-model";

type View = "group" | "every";

const measurementsOf = (workflow: BundledWorkflow) =>
  workflow.outputs.filter((o) => o.kind === "measurement");

export function ResultsPage() {
  const { detail, workflow } = useStudy();
  const [search, setSearch] = useSearchParams();
  const view: View = search.get("view") === "every" ? "every" : "group";
  const outputs = measurementsOf(workflow);
  const finished = detail.scans.filter((s) => s.resultRunId !== null).length;
  const toCome = detail.scans.length - finished;
  return (
    <>
      <PageHead
        title="Results"
        subtitle={`${outputs.length} measurements from ${finished} finished ${finished === 1 ? "scan" : "scans"}${toCome ? `; ${toCome} to come` : ""}`}
        actions={
          finished > 0 && (
            <Button variant="primary" onClick={() => exportCsv(detail, outputs)}>
              <Download aria-hidden />
              Export values
            </Button>
          )
        }
      />
      {finished === 0 ? (
        <EmptyState title="No values yet">Values appear here as each scan finishes.</EmptyState>
      ) : (
        <section aria-labelledby="results">
          <header className="flex h-(--panel-head-h) items-center gap-3 px-4">
            <h2 id="results" className="m-0 text-sm font-semibold">
              {view === "group" ? "By group, each dot a scan" : "Every value"}
            </h2>
            <SegmentedControl<View>
              label="Show"
              className="ml-auto"
              value={view}
              onValueChange={(v) => setSearch(v === "group" ? {} : { view: v }, { replace: true })}
              options={[
                { value: "group", label: "By group" },
                { value: "every", label: "Every value" },
              ]}
            />
          </header>
          {view === "group" ? (
            <ResultsTable detail={detail} workflow={workflow} outputs={outputs} byTask />
          ) : (
            <EveryValue detail={detail} workflow={workflow} outputs={outputs} />
          )}
        </section>
      )}
    </>
  );
}

function EveryValue({
  detail,
  workflow,
  outputs,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
  outputs: OutputEntry[];
}) {
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  const scans = groupNames(detail).flatMap((g) =>
    detail.scans.filter((s) => groupOf(s, grouped) === g && s.resultRunId !== null),
  );
  const far = new Map(outputs.map((o) => [o.id, farFromGroup(detail, o)]));
  const digits = new Map(outputs.map((o) => [o.id, digitsFor(valuesOf(detail, o))]));
  const columns: TableColumn<OutputEntry>[] = [
    {
      key: "measure",
      header: "Measurement",
      cell: (o) => (
        <span className="font-normal whitespace-nowrap">
          {o.name} <span className="text-xs text-fg-subtle">{unitOf(o)}</span>
        </span>
      ),
    },
    ...scans.map(
      (s): TableColumn<OutputEntry> => ({
        key: s.scan.inputId,
        align: "end",
        header: (
          <span className="grid justify-items-end font-mono leading-tight">
            {s.scan.subject}
            {grouped && <span className="text-[10px]">{s.scan.group}</span>}
          </span>
        ),
        cell: (o) => {
          const v = scanValue(s, o);
          if (v === null) return null;
          const isFar = far.get(o.id)?.has(s.scan.inputId);
          return (
            <span
              className={cx(
                "rounded-sm px-1 font-mono text-sm",
                isFar && "bg-check-tint font-semibold text-check",
              )}
            >
              {v.toFixed(digits.get(o.id))}
            </span>
          );
        },
      }),
    ),
  ];
  return (
    <Table
      label="Every value"
      density="compact"
      columns={columns}
      rows={outputs}
      rowKey={(o) => o.id}
      groupOf={(o) => workflow.taskTitle(o.task)}
      className="rounded-none border-x-0 border-b-0"
    />
  );
}

/** One row per scan, one column per measurement (its unit in the head), as a CSV download. */
function exportCsv(detail: StudyDetail, outputs: OutputEntry[]) {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const head = ["Scan", "Group", "Knee", ...outputs.map((o) => `${o.name} (${unitOf(o) || "-"})`)];
  const row = (s: StudyScanDetail) => [
    s.scan.subject,
    s.scan.group ?? "",
    kneeOf(s) ?? "",
    ...outputs.map((o) => String(scanValue(s, o) ?? "")),
  ];
  const csv = [head, ...detail.scans.filter((s) => s.resultRunId !== null).map(row)]
    .map((r) => r.map(cell).join(","))
    .join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${detail.study.name}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
