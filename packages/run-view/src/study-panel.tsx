/**
 * The study panel: the study's name, how far its scans are (one Progress cell per scan) and its
 * scans by group, each with its state, linking to the scan's review. It is the left panel one
 * click away on every study page and in the scan review, so both render it from here. Also the
 * scan-level facts both read from a `StudyDetail`: a scan's status, knee and group.
 */
import type { StudyDetail, StudyRunSummary, StudyScanDetail } from "@voluma/contracts/study";
import { type LinkTo, List, Progress, Row, RowLink, type Status, StatusMark } from "@voluma/ui";
import { liveStatus, plural } from "./run-status";

type ScanStatus = { label: string; status: Status; open: number };

/**
 * A scan's status: its newest run's (`runStatus`), with "Task N of M" while it runs and its open
 * checks; "Not started" without a run. Its values may come from an older completed run.
 */
export function scanStatus({ runs: [run], toCheck }: StudyScanDetail): ScanStatus {
  if (!run) return { label: "Not started", status: "waiting", open: 0 };
  const { label, status } = liveStatus(run);
  const open = status === "check" ? toCheck.length : 0;
  return { label: open > 0 ? `${open} to check` : label, status, open };
}

/** A scan's knee (`attributes.knee`, as `/new`'s intake stores it), or null. */
export function kneeOf(scan: StudyScanDetail): string | null {
  const knee = scan.scan.attributes.knee;
  return typeof knee === "string" && knee ? knee : null;
}

/** The row a scan sits on: its group, or one shared row when no scan of the study has one. */
export const groupOf = (scan: StudyScanDetail, grouped: boolean) =>
  scan.scan.group ?? (grouped ? "No group" : "All scans");

/** Groups in the order their first scan appears in the study. */
export function groupNames(detail: StudyDetail): string[] {
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  return [...new Set(detail.scans.map((s) => groupOf(s, grouped)))];
}

/** A run the API or the runner is still moving: a page refetches while one is in view. */
export const isLive = (run: Pick<StudyRunSummary, "state"> | undefined) =>
  run !== undefined && run.state.status !== "ended";

/** "11 of 20 finished, 2 running". */
function finishedLine(detail: StudyDetail): string {
  const finished = detail.scans.filter((s) => s.resultRunId !== null).length;
  const running = detail.scans.filter((s) => s.runs[0]?.state.status === "running").length;
  return `${finished} of ${detail.scans.length} finished${running ? `, ${running} running` : ""}`;
}

export function StudyPanel({
  detail,
  about,
  scanLink,
  current,
}: {
  detail: StudyDetail;
  /** One line under the name: what the study is, e.g. "20 knees, Mouse OA knee". */
  about: string;
  /** Where a scan's row goes; `undefined` for a scan with no run yet. */
  scanLink: (scan: StudyScanDetail) => LinkTo | undefined;
  /** The scan open in the review, drawn selected. */
  current?: string;
}) {
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-1 border-b border-border px-4 pt-3 pb-3.5">
        <p className="m-0 font-semibold">{detail.study.name}</p>
        <p className="m-0 text-sm text-muted-foreground">{about}</p>
        <Progress states={detail.scans.map((s) => scanStatus(s).status)} className="mt-1.5" />
        <p className="m-0 text-sm text-muted-foreground">{finishedLine(detail)}</p>
      </div>
      {groupNames(detail).map((group) => {
        const scans = detail.scans.filter((s) => groupOf(s, grouped) === group);
        return (
          <section
            key={group}
            aria-label={`${group}, ${plural(scans.length, "scan")}`}
            className="pt-2"
          >
            {grouped && <h3 className="m-0 px-4 pb-1 text-xs text-muted-foreground">{group}</h3>}
            <List density="compact" columns="auto" label={group}>
              {scans.map((scan) => (
                <PanelRow
                  key={scan.scan.inputId}
                  scan={scan}
                  to={scanLink(scan)}
                  selected={current === scan.scan.inputId}
                />
              ))}
            </List>
          </section>
        );
      })}
    </div>
  );
}

function PanelRow({
  scan,
  to,
  selected,
}: {
  scan: StudyScanDetail;
  to: LinkTo | undefined;
  selected: boolean;
}) {
  const { label, status } = scanStatus(scan);
  const knee = kneeOf(scan);
  const title = (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="w-14 shrink-0 font-mono text-sm">{scan.scan.subject}</span>
      {knee && <span className="truncate font-normal text-muted-foreground">{knee} knee</span>}
    </span>
  );
  const cell = <StatusMark status={status} label={label} className="text-xs" />;
  return to ? (
    <RowLink to={to} title={title} cells={[cell]} selected={selected} />
  ) : (
    <Row title={title} cells={[cell]} />
  );
}
