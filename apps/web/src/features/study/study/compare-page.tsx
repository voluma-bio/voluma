/**
 * Compare (`/studies/:id/compare`): how the numbers compare. The workflow's headline measurements
 * as strip plots by group, then every sample × every measurement, measurements under the task that
 * reports them (a task folds to its headline measurement), samples grouped as on the study page.
 * A cell shows its value and its state (`segmentOf`); a value far from its group is amber. A cell
 * opens the sample's scan review at its task, a dot its scan. `?status=<place>` shows one group.
 * "Export values" downloads the values as CSV, one row per sample.
 */
import type { StudyDetail, StudyScanDetail } from "@voluma/contracts/study";
import type { OutputEntry } from "@voluma/contracts/workflow-files";
import { kneeOf, runHref, scanStatus } from "@voluma/run-view";
import { Button, Count, cx, StatusGlyph, StatusMark } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { measurementsOf } from "../workflow-tasks";
import { SEGMENT_LOOK } from "./sample-bar";
import { useStudy } from "./study-layout";
import {
  digitsFor,
  farFromGroup,
  keyOutput,
  kneeWord,
  otherUnit,
  PLACES,
  placeOf,
  placeParam,
  SEGMENT_WORD,
  type Segment,
  scanValue,
  sectionsOf,
  segmentOf,
  unitOf,
  valuesOf,
} from "./study-model";
import { MeasurePlot } from "./study-side";

export function ComparePage() {
  const { detail, workflow } = useStudy();
  const [search] = useSearchParams();
  const only = placeParam(search.get("status"));
  const outputs = measurementsOf(workflow);
  const plotted = workflow.headline.filter((o) => valuesOf(detail, o).length > 0);
  const finished = detail.scans.filter((s) => s.resultRunId !== null).length;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      {plotted.length > 0 ? (
        <section aria-label="Headline measurements" className="border-b border-border">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-x-8 gap-y-4 px-6 pt-4 pb-3">
            {plotted.map((o) => (
              <figure key={o.id} className="m-0 grid gap-2">
                <figcaption className="flex items-baseline gap-2 text-sm font-semibold">
                  {o.name}
                  <span className="font-normal text-fg-subtle">{unitOf(o)}</span>
                </figcaption>
                <MeasurePlot detail={detail} output={o} />
              </figure>
            ))}
          </div>
        </section>
      ) : (
        <p className="m-0 border-b border-border px-6 py-4 text-sm text-muted-foreground">
          No values to compare yet. Each sample's appear when its run finishes.
        </p>
      )}
      <ValuesTable
        detail={detail}
        workflow={workflow}
        only={only}
        actions={
          finished > 0 && (
            <Button size="sm" onClick={() => exportCsv(detail, outputs)}>
              <Download aria-hidden />
              Export values
            </Button>
          )
        }
      />
    </div>
  );
}

const LEGEND: Segment[] = ["check", "stale", "missing", "making", "waiting"];

function ValuesTable({
  detail,
  workflow,
  only,
  actions,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
  only: ReturnType<typeof placeParam>;
  actions: ReactNode;
}) {
  const sections = sectionsOf(workflow);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const allFolded = folded.size === sections.length;
  const shown = sections.map((s) => ({
    ...s,
    folded: folded.has(s.taskId),
    columns: folded.has(s.taskId) ? [keyOutput(workflow, s)] : s.outputs,
  }));
  const columns = shown.flatMap((s) => s.columns);
  const far = new Map(columns.map((o) => [o.id, farFromGroup(detail, o)]));
  const digits = new Map(columns.map((o) => [o.id, digitsFor(valuesOf(detail, o))]));
  const groups = PLACES.map((p) => ({
    ...p,
    scans: detail.scans.filter((s) => placeOf(s) === p.place),
  })).filter((g) => g.scans.length > 0 && (!only || g.place === only));
  const toggle = (taskId: string) =>
    setFolded((now) => {
      const next = new Set(now);
      if (!next.delete(taskId)) next.add(taskId);
      return next;
    });

  return (
    <section aria-labelledby="values">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2.5">
        <h2 id="values" className="m-0 text-sm font-semibold">
          Results
        </h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFolded(allFolded ? new Set() : new Set(sections.map((s) => s.taskId)))}
        >
          {allFolded ? "Unfold tasks" : "Fold tasks"}
        </Button>
        <ul className="m-0 ml-auto flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
          {LEGEND.map((s) => (
            <li key={s} className="flex items-center gap-1.5">
              <i className={cx("block h-2.5 w-1 rounded-[1px]", SEGMENT_LOOK[s])} />
              {SEGMENT_WORD[s]}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span className="rounded-sm bg-check-tint px-1 font-mono text-check">1.0</span>
            Far from its group
          </li>
        </ul>
        {actions}
      </header>
      <div className="overflow-x-auto border-t border-border">
        <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th
                rowSpan={2}
                scope="col"
                className="sticky left-0 z-[2] min-w-56 border-r border-b border-border bg-card px-4 py-1.5 text-left align-bottom text-xs font-medium text-muted-foreground"
              >
                Sample
              </th>
              {shown.map((s) => (
                <th
                  key={s.taskId}
                  colSpan={s.columns.length}
                  scope="colgroup"
                  className="border-r border-border px-2 pt-2 pb-1 text-left font-semibold whitespace-nowrap"
                >
                  <button
                    type="button"
                    aria-expanded={!s.folded}
                    onClick={() => toggle(s.taskId)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {s.folded ? (
                      <ChevronRight aria-hidden className="size-3.5 text-fg-subtle" />
                    ) : (
                      <ChevronDown aria-hidden className="size-3.5 text-fg-subtle" />
                    )}
                    {s.title}
                    {s.folded && s.outputs.length > 1 && (
                      <span className="font-normal text-fg-subtle">
                        {" "}
                        · {s.outputs.length - 1} more
                      </span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
            <tr>
              {shown.flatMap((s) =>
                s.columns.map((o, i) => (
                  <th
                    key={o.id}
                    scope="col"
                    className={cx(
                      "w-24 max-w-28 border-b border-border px-2 pb-1.5 text-right align-bottom text-xs leading-tight font-medium",
                      i === s.columns.length - 1 && "border-r",
                    )}
                  >
                    {/* "meniscus/osteophyte" may break after its slash, not run into the next column. */}
                    {o.name.replaceAll("/", "/\u200b")}
                    <span className="block font-normal text-fg-subtle">{unitOf(o)}</span>
                  </th>
                )),
              )}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.place}>
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={columns.length + 1}
                  className="border-b border-border bg-muted px-4 py-1.5 text-left font-semibold"
                >
                  <span className="sticky left-4 inline-flex items-center gap-2">
                    {g.title}
                    <Count>{g.scans.length}</Count>
                  </span>
                </th>
              </tr>
              {g.scans.map((scan) => {
                const run = scan.runs[0];
                const knee = kneeOf(scan);
                return (
                  <tr key={scan.scan.inputId} className="group/row">
                    <th
                      scope="row"
                      className="sticky left-0 z-[1] border-r border-b border-border bg-card px-4 py-1.5 text-left font-normal group-hover/row:bg-accent"
                    >
                      <span className="flex items-center gap-3">
                        {run ? (
                          <Link
                            to={runHref({ runId: run.id })}
                            className="font-mono font-semibold hover:underline"
                          >
                            {scan.scan.subject}
                          </Link>
                        ) : (
                          <span className="font-mono font-semibold">{scan.scan.subject}</span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {[scan.scan.group, knee && kneeWord(knee)].filter(Boolean).join(" · ")}
                        </span>
                        <StatusMark {...scanStatus(scan)} className="ml-auto text-xs" />
                      </span>
                    </th>
                    {shown.flatMap((s) =>
                      s.columns.map((o, i) => (
                        <td
                          key={o.id}
                          className={cx(
                            "border-b border-border p-0 text-right group-hover/row:bg-accent",
                            i === s.columns.length - 1 && "border-r",
                          )}
                        >
                          {/* The row's sample link is the keyboard way in; a cell is a mouse shortcut to its task. */}
                          {run ? (
                            <Link
                              to={`${runHref({ runId: run.id })}?task=${o.task}`}
                              tabIndex={-1}
                              className="block px-2 py-1.5"
                            >
                              <Cell
                                scan={scan}
                                output={o}
                                digits={digits.get(o.id) ?? 2}
                                far={far.get(o.id)?.has(scan.scan.inputId) ?? false}
                              />
                            </Link>
                          ) : (
                            <span className="block px-2 py-1.5" />
                          )}
                        </td>
                      )),
                    )}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

/** One value with its state: the number where there is one, else a bar of the state's colour. */
function Cell({
  scan,
  output,
  digits,
  far,
}: {
  scan: StudyScanDetail;
  output: OutputEntry;
  digits: number;
  far: boolean;
}) {
  if (!scan.runs[0] || Object.keys(scan.taskState).length === 0) return null;
  const state = segmentOf(scan, output);
  const value = scanValue(scan, output);
  const unit = otherUnit(scan, output);
  const word = SEGMENT_WORD[state];
  if (state === "missing")
    return <span className="text-xs text-fg-subtle">{SEGMENT_WORD.missing}</span>;
  if (value === null && unit) return <span className="text-xs text-fg-subtle">in {unit}</span>;
  if (value === null)
    return (
      <span
        role="img"
        aria-label={word}
        title={word}
        className={cx("ml-auto block h-1.5 w-10 rounded-full", SEGMENT_LOOK[state])}
      />
    );
  return (
    <span
      title={state === "reported" ? undefined : word}
      className={cx(
        "inline-flex items-center gap-1 rounded-sm px-1 font-mono tabular-nums",
        state === "check" && "bg-check-tint text-check",
        state === "stale" && "text-fg-subtle line-through",
        state === "making" && "text-fg-subtle",
        far && state !== "stale" && "bg-check-tint font-semibold text-check",
      )}
    >
      {state === "check" && <StatusGlyph status="check" className="size-3" />}
      {value.toFixed(digits)}
    </span>
  );
}

/** One row per sample, one column per measurement (its unit in the head), as a CSV download. */
function exportCsv(detail: StudyDetail, outputs: OutputEntry[]) {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  // Typed text (subject, group, names) that a spreadsheet would run as a formula opens as text;
  // a leading tab or carriage return can hide one.
  const text = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  const head = [
    "Sample",
    "Group",
    "Knee",
    ...outputs.map((o) => text(`${o.name} (${unitOf(o) || "-"})`)),
  ];
  const row = (s: StudyScanDetail) => [
    text(s.scan.subject),
    text(s.scan.group ?? ""),
    text(kneeOf(s) ?? ""),
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
  // The download reads the URL after this task; revoking at once can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
