/**
 * The study's dashboard (`/studies/:id`): one sentence on where the study stands, the workflow
 * across every scan (TaskGraph at study size; a box opens the Workflow page on that task), every
 * scan by every task, what needs the researcher next to what is running, the spend, and the
 * headline measurements by group.
 */
import type { StudyDetail, StudyScanDetail } from "@voluma/contracts/study";
import { formatUsd, plural, scanStatus, TaskGraph } from "@voluma/run-view";
import { Box, Button, Count, EmptyState, List, PageHead, RowLink, StatusMark } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { Box as Cube, Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { linkTo } from "../link";
import { ResultsTable } from "./results-table";
import { ScanMatrix } from "./scan-matrix";
import { useStudy } from "./study-layout";
import {
  farFromGroup,
  scanHref,
  scanName,
  stoppedIn,
  studyGraph,
  studySpend,
  taskState,
} from "./study-model";

export function Dashboard() {
  const { detail, workflow } = useStudy();
  const navigate = useNavigate();
  const base = `/studies/${detail.study.id}`;
  const next = mostToCheck(detail);
  const nextHref = next && scanHref(next);
  return (
    <>
      <PageHead
        title={detail.study.name}
        subtitle={<StudyFacts detail={detail} workflow={workflow} />}
        actions={
          nextHref && (
            <Button asChild variant="primary">
              <Link to={nextHref}>
                <Cube aria-hidden />
                Review {next.scan.subject}
              </Link>
            </Button>
          )
        }
      />
      <Summary detail={detail} workflow={workflow} base={base} />
      <section aria-labelledby="workflow" className="border-b border-border">
        <header className="flex h-(--panel-head-h) items-center gap-2 px-4">
          <h2 id="workflow" className="m-0 text-sm font-semibold">
            Workflow, across {plural(detail.scans.length, "scan")}
          </h2>
          <Button asChild variant="ghost" size="sm" className="ml-auto">
            <Link to={`${base}/workflow`}>
              <Maximize2 aria-hidden />
              Expand
            </Link>
          </Button>
        </header>
        <div className="overflow-x-auto px-4 pt-2 pb-4">
          <TaskGraph
            size="study"
            tasks={studyGraph(detail, workflow)}
            onSelect={(task) => navigate(`${base}/workflow?task=${encodeURIComponent(task)}`)}
            className="min-w-[44rem]"
          />
        </div>
      </section>
      <ScanMatrix detail={detail} workflow={workflow} />
      <div className="grid grid-cols-2 gap-px border-b border-border bg-border max-[1100px]:grid-cols-1">
        <NeedsYou detail={detail} workflow={workflow} base={base} />
        <div className="flex flex-col bg-card [&>section+section]:border-t [&>section+section]:border-border">
          <RunningNow detail={detail} workflow={workflow} />
          <Spent detail={detail} />
        </div>
      </div>
      <Box
        title="Results by group"
        tools={
          <>
            <span className="text-sm text-fg-subtle">
              {workflow.headline.length} of {measures(workflow)} measurements
            </span>
            <Button asChild variant="link">
              <Link to={`${base}/results`}>All {measures(workflow)} in Results</Link>
            </Button>
          </>
        }
      >
        {detail.scans.some((s) => s.resultRunId !== null) ? (
          <ResultsTable detail={detail} workflow={workflow} outputs={workflow.headline} />
        ) : (
          <EmptyState title="No values yet">Values appear here as each scan finishes.</EmptyState>
        )}
      </Box>
    </>
  );
}

const measures = (workflow: BundledWorkflow) =>
  workflow.outputs.filter((o) => o.kind === "measurement").length;

/** The scan with the most open checks: where "Review" starts. */
function mostToCheck(detail: StudyDetail): StudyScanDetail | undefined {
  return [...detail.scans]
    .filter((s) => s.toCheck.length > 0)
    .sort((a, b) => b.toCheck.length - a.toCheck.length)[0];
}

/** "10 DMM, left knees. 10 Sham, right knees.", then the workflow. */
export function StudyFacts({
  detail,
  workflow,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
}) {
  const groups = new Map<string, StudyScanDetail[]>();
  for (const s of detail.scans) {
    const g = s.scan.group ?? "";
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const lines = [...groups].map(([group, scans]) => {
    const knees = [...new Set(scans.map((s) => s.scan.attributes.knee))];
    const knee = knees.length === 1 && typeof knees[0] === "string" ? knees[0].toLowerCase() : null;
    const what = knee ? `${knee} ${scans.length === 1 ? "knee" : "knees"}` : null;
    return [group ? `${scans.length} ${group}` : plural(scans.length, "scan"), what]
      .filter(Boolean)
      .join(", ");
  });
  return (
    <>
      <span className="flex flex-wrap gap-x-4">
        {lines.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </span>
      <span className="block">{workflow.name}</span>
    </>
  );
}

/**
 * The study in one sentence: how many scans finished, then what needs the researcher (items to
 * check, stopped scans, a value far from its group) and what is running. Each part links to the
 * page that lists it.
 */
function Summary({
  detail,
  workflow,
  base,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
  base: string;
}) {
  const finished = detail.scans.filter((s) => s.resultRunId !== null).length;
  const items = detail.scans.reduce((n, s) => n + s.toCheck.length, 0);
  const withItems = detail.scans.filter((s) => s.toCheck.length > 0).length;
  const stopped = detail.scans.filter((s) => scanStatus(s).status === "stopped").length;
  const far = [
    ...new Set(
      workflow.headline.flatMap((o) =>
        [...farFromGroup(detail, o).keys()].map(
          (id) => detail.scans.find((s) => s.scan.inputId === id)?.scan.subject ?? id,
        ),
      ),
    ),
  ];
  const running = detail.scans.filter((s) => s.runs[0]?.state.status === "running");
  const tasks = running.reduce(
    (n, s) =>
      n + Object.values(s.taskState).filter((t) => t === "running" || t === "checking").length,
    0,
  );

  const parts: ReactNode[] = [];
  if (items > 0)
    parts.push(
      <Link key="check" to={`${base}/check`} className="text-check hover:underline">
        {plural(items, "item")} {items === 1 ? "waits" : "wait"} for your check across{" "}
        {plural(withItems, "scan")}
      </Link>,
    );
  if (stopped > 0)
    parts.push(
      <Link key="stopped" to={`${base}/scans`} className="text-destructive hover:underline">
        {plural(stopped, "scan")} stopped
      </Link>,
    );
  if (far.length > 0)
    parts.push(
      <Link key="far" to={`${base}/results`} className="hover:underline">
        {list(far)} {far.length === 1 ? "measures" : "measure"} far from{" "}
        {far.length === 1 ? "its" : "their"} group
      </Link>,
    );
  if (tasks > 0)
    parts.push(
      <span key="running" className="text-info">
        {plural(tasks, "task")} {tasks === 1 ? "is" : "are"} running on{" "}
        {plural(running.length, "scan")}
      </span>,
    );

  return (
    <p className="m-0 border-b border-border px-6 py-3.5 text-lg text-pretty">
      <b className="font-semibold">
        {finished} of {plural(detail.scans.length, "scan")} finished.
      </b>{" "}
      {parts.length > 0 ? (
        <>
          {parts.flatMap((p, i) => [i === 0 ? null : i === parts.length - 1 ? " and " : ", ", p])}.
        </>
      ) : finished === detail.scans.length ? (
        "Nothing waits for you."
      ) : null}
    </p>
  );
}

/** "OA7-2", "OA7-2 and OA7-13", "OA7-2, OA7-4 and OA7-13". */
const list = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** Scans with open checks (most first), then stopped scans and scans waiting for keys. */
function NeedsYou({
  detail,
  workflow,
  base,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
  base: string;
}) {
  const far = new Set(workflow.headline.flatMap((o) => [...farFromGroup(detail, o).keys()]));
  const rows: { scan: StudyScanDetail; subtitle: string; cell: ReactNode }[] = [];
  for (const scan of [...detail.scans].sort((a, b) => b.toCheck.length - a.toCheck.length)) {
    const run = scan.runs[0];
    if (scan.toCheck.length > 0)
      rows.push({
        scan,
        subtitle: [...new Set(scan.toCheck.map((i) => i.title))].join(", "),
        cell: (
          <span className="flex items-center gap-2">
            {far.has(scan.scan.inputId) && <span className="text-xs text-check">far</span>}
            <StatusMark status="check" label={`${scan.toCheck.length} to check`} />
          </span>
        ),
      });
    else if (run?.state.status === "awaiting-keys")
      rows.push({
        scan,
        subtitle: "Paused until you add your API key",
        cell: <StatusMark status="paused" label="Needs your keys" />,
      });
    else if (scanStatus(scan).status === "stopped") {
      const where = stoppedIn(scan, workflow);
      rows.push({
        scan,
        subtitle: where ? `Stopped during ${where}` : "Stopped before it finished",
        cell: <StatusMark status="stopped" />,
      });
    }
  }
  return (
    <Box
      title="Needs you"
      count={rows.length > 0 && <Count tone="check">{rows.length}</Count>}
      tools={
        <Button asChild variant="link">
          <Link to={`${base}/check`}>To check</Link>
        </Button>
      }
    >
      {rows.length > 0 ? (
        <List columns="auto" label="Needs you">
          {rows.map(({ scan, subtitle, cell }) => {
            const href = scanHref(scan);
            const props = { title: scanName(scan), subtitle, cells: [cell] };
            return href ? <RowLink key={scan.scan.inputId} to={linkTo(href)} {...props} /> : null;
          })}
        </List>
      ) : (
        <EmptyState title="Nothing needs you">
          Items to check and scans that stop show here.
        </EmptyState>
      )}
    </Box>
  );
}

/** Scans with a live run: what each is working on, and who waits for a free runner. */
function RunningNow({ detail, workflow }: { detail: StudyDetail; workflow: BundledWorkflow }) {
  const running = detail.scans.filter((s) => s.runs[0]?.state.status === "running");
  const waiting = detail.scans.filter((s) => s.runs[0]?.state.status === "queued");
  const working = (s: StudyScanDetail) =>
    workflow.tasks
      .filter((t) => {
        const state = taskState(s, t.id);
        return state === "running" || state === "checking";
      })
      .map((t) => workflow.taskTitle(t.id));
  return (
    <Box
      title="Running now"
      count={running.length > 0 && <Count tone="running">{running.length}</Count>}
      foot={
        waiting.length > 0 &&
        `${list(waiting.map((s) => s.scan.subject))} ${waiting.length === 1 ? "starts" : "start"} as a runner frees up.`
      }
    >
      {running.length > 0 ? (
        <List columns="auto" label="Running now">
          {running.map((scan) => {
            const href = scanHref(scan);
            const { label } = scanStatus(scan);
            return (
              href && (
                <RowLink
                  key={scan.scan.inputId}
                  to={linkTo(href)}
                  title={scanName(scan)}
                  subtitle={list(working(scan)) || "Between tasks"}
                  cells={[<StatusMark key="s" status="running" label={label} />]}
                />
              )
            );
          })}
        </List>
      ) : (
        <EmptyState title="Nothing running" />
      )}
    </Box>
  );
}

/** What the study's runs have spent, against its budget when it has one. */
function Spent({ detail }: { detail: StudyDetail }) {
  const spent = studySpend(detail);
  const budget = detail.study.budgetUsd;
  return (
    <Box
      title="Spent"
      tools={
        <span className="font-mono text-sm">
          {formatUsd(spent)}
          {budget !== null && <span className="text-fg-subtle"> of {formatUsd(budget)}</span>}
        </span>
      }
    >
      {null}
    </Box>
  );
}
