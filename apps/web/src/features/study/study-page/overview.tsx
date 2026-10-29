/**
 * The study's Overview tab: "By group" strip plots, one per headline measurement of the
 * workflow; "Needs your eye" beside them (scans far from their group, runs that stopped on
 * something the researcher must do, and the To check kinds with counts); scan tiles under it.
 * On a phone, Needs your eye comes first.
 */
import type { StudyDetail, StudyScanDetail } from "@voluma/contracts/study";
import { StatusBadge, StripPlot } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  checkKinds,
  digitsFor,
  type Far,
  farFromGroup,
  groupNames,
  groupOf,
  runPath,
  scanStatus,
  scanValue,
  valuesOf,
} from "./study-model";

type Props = {
  detail: StudyDetail;
  workflow: BundledWorkflow;
  onTab: (tab: "check" | "scans") => void;
};

export function Overview({ detail, workflow, onTab }: Props) {
  const measures = workflow.headline.map((output) => {
    const values = valuesOf(detail, output.id);
    return { output, digits: digitsFor(values), far: farFromGroup(detail, output.id) };
  });
  const hasValues = detail.scans.some((s) => s.resultRunId !== null);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_22rem] items-start gap-x-8 gap-y-6 max-[1100px]:grid-cols-1">
      <section aria-labelledby="by-group" className="grid min-w-0 gap-3 max-[1100px]:order-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="by-group" className="text-sm font-semibold">
            By group
          </h2>
          {hasValues && <Legend />}
        </div>
        {!hasValues ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-ui text-muted-foreground">
            Values appear here as each scan finishes.
          </p>
        ) : (
          measures.map(({ output, digits, far }) => (
            <MeasureCard
              key={output.id}
              detail={detail}
              outputId={output.id}
              name={output.name}
              unit={unitOf(output)}
              digits={digits}
              far={far}
              task={output.task}
            />
          ))
        )}
        {hasValues && (
          <button
            type="button"
            onClick={() => onTab("scans")}
            className="justify-self-start text-ui text-primary-text hover:underline"
          >
            All values in a table
          </button>
        )}
      </section>
      <aside className="grid min-w-0 gap-6 max-[1100px]:order-1">
        <NeedsYourEye detail={detail} workflow={workflow} measures={measures} onTab={onTab} />
        <ScanTiles detail={detail} />
      </aside>
    </div>
  );
}

const unitOf = (output: BundledWorkflow["headline"][number]) =>
  "unit" in output && typeof output.unit === "string" ? output.unit : "";

function Legend() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-fg-subtle">
      <span className="flex items-center gap-1.5">
        <svg width="10" height="10" aria-hidden>
          <circle cx="5" cy="5" r="4.5" className="fill-foreground" />
        </svg>
        A scan
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="4" height="14" aria-hidden>
          <rect x="1" width="2" height="14" className="fill-muted-foreground" />
        </svg>
        Group mean
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="10" height="10" aria-hidden>
          <circle cx="5" cy="5" r="4.5" className="fill-check-solid" />
        </svg>
        Far from its group
      </span>
    </p>
  );
}

function MeasureCard({
  detail,
  outputId,
  name,
  unit,
  digits,
  far,
  task,
}: {
  detail: StudyDetail;
  outputId: string;
  name: string;
  unit: string;
  digits: number;
  far: Map<string, Far>;
  task: string;
}) {
  const navigate = useNavigate();
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  const groups = groupNames(detail).map((group) => ({
    name: group,
    points: detail.scans
      .filter((s) => groupOf(s, grouped) === group)
      .map((s) => {
        const f = far.get(s.scan.inputId);
        return {
          id: s.scan.inputId,
          label: s.scan.subject,
          value: scanValue(s, outputId),
          far: f !== undefined,
          farReason: f && `The ${others(s)} measure ${range(f.others, digits)} ${unit}`,
        };
      }),
  }));
  const byId = new Map(detail.scans.map((s) => [s.scan.inputId, s]));
  return (
    <div className="rounded-xl border border-border bg-card px-4 pt-2.5 pb-1">
      <p className="mb-1 text-sm">
        <span className="font-semibold">{name}</span> <span className="text-fg-subtle">{unit}</span>
      </p>
      <StripPlot
        groups={groups}
        unit={unit}
        label={name}
        digits={digits}
        onSelect={(point) => {
          const scan = byId.get(point.id);
          if (scan?.resultRunId)
            navigate(`/runs/${scan.resultRunId}?task=${encodeURIComponent(task)}`);
        }}
      />
    </div>
  );
}

/** Who a far scan is compared with: its group's other scans. */
const others = (scan: StudyScanDetail) =>
  scan.scan.group ? `other ${scan.scan.group} scans` : "other scans";

const range = ([lo, hi]: [number, number], digits: number) =>
  lo === hi ? lo.toFixed(digits) : `${lo.toFixed(digits)}–${hi.toFixed(digits)}`;

function NeedsYourEye({
  detail,
  workflow,
  measures,
  onTab,
}: {
  detail: StudyDetail;
  workflow: BundledWorkflow;
  measures: {
    output: BundledWorkflow["headline"][number];
    digits: number;
    far: Map<string, Far>;
  }[];
  onTab: (tab: "check" | "scans") => void;
}) {
  const byId = new Map(detail.scans.map((s) => [s.scan.inputId, s]));
  const alerts: ReactNode[] = [];
  for (const { output, digits, far } of measures) {
    for (const [inputId, f] of far) {
      const scan = byId.get(inputId);
      if (!scan?.resultRunId) continue;
      const value = scanValue(scan, output.id);
      const unit = unitOf(output);
      alerts.push(
        <Alert
          key={`far-${output.id}-${inputId}`}
          action={
            <Link
              to={`/runs/${scan.resultRunId}?task=${encodeURIComponent(output.task)}`}
              className={smallButton}
            >
              Open in 3D
            </Link>
          }
        >
          <b className="font-semibold">{scan.scan.subject} is far from its group.</b> {output.name}{" "}
          <span className="font-mono tabular-nums">{value?.toFixed(digits)}</span> {unit}; the{" "}
          {others(scan)} measure{" "}
          <span className="font-mono tabular-nums">{range(f.others, digits)}</span> {unit}.
        </Alert>,
      );
    }
  }
  for (const scan of detail.scans) {
    const run = scan.runs[0];
    const path = runPath(scan);
    if (!run || !path) continue;
    if (run.state.status === "awaiting-keys")
      alerts.push(
        <Alert
          key={`keys-${scan.scan.inputId}`}
          action={
            <Link to={path} className={smallButton}>
              Open the run
            </Link>
          }
        >
          <b className="font-semibold">{scan.scan.subject} needs your keys</b> to carry on.
        </Alert>,
      );
    if (run.state.status === "ended" && run.state.outcome === "failed")
      alerts.push(
        <Alert
          key={`failed-${scan.scan.inputId}`}
          quiet
          action={
            <Link to={path} className={smallButton}>
              Open the run
            </Link>
          }
        >
          <b className="font-semibold">{scan.scan.subject}'s run failed.</b>{" "}
          <span className="line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]">
            {failure(run.state.error)}
          </span>
        </Alert>,
      );
  }
  const kinds = checkKinds(detail, workflow);
  const anyDone = detail.scans.some((s) => s.resultRunId !== null);
  return (
    <section aria-labelledby="needs-eye" className="grid gap-2">
      <h2 id="needs-eye" className="text-sm font-semibold">
        Needs your eye
      </h2>
      {alerts}
      {kinds.length > 0 ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {kinds.map((kind) => (
            <li key={kind.key}>
              <button
                type="button"
                onClick={() => onTab("check")}
                className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left text-ui hover:bg-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{kind.taskTitle}</span>
                  <span className="block truncate text-meta text-fg-subtle">{kind.title}</span>
                </span>
                <span className="rounded-full border border-check-line bg-check-tint px-2 font-mono text-meta text-check tabular-nums">
                  {kind.items.length}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        alerts.length === 0 && (
          <p className="text-ui text-muted-foreground">
            {anyDone ? "Nothing to check." : "Nothing yet. Items appear as each scan finishes."}
          </p>
        )
      )}
    </section>
  );
}

/** A failed run's reason without the provider's raw response body, which the run page shows. */
const failure = (error: string | undefined) =>
  error?.split("{")[0]?.replace(/[\s:]+$/, "") || "It stopped before it finished.";

const smallButton =
  "inline-flex h-8 shrink-0 items-center rounded-lg border border-border bg-card px-3 text-ui font-medium whitespace-nowrap hover:bg-accent";

/** Amber for what the researcher must look at; `quiet` (a card) for a run that failed. */
function Alert({
  children,
  action,
  quiet = false,
}: {
  children: ReactNode;
  action: ReactNode;
  quiet?: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-ui ${
        quiet ? "border-border bg-card" : "border-check-line bg-check-tint"
      }`}
    >
      <p className="m-0 min-w-0 flex-1">{children}</p>
      {action}
    </div>
  );
}

function ScanTiles({ detail }: { detail: StudyDetail }) {
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  return (
    <section aria-labelledby="scan-tiles" className="grid gap-2">
      <h2 id="scan-tiles" className="text-sm font-semibold">
        Scans
      </h2>
      {groupNames(detail).map((group) => (
        <div key={group} className="grid gap-1.5">
          {grouped && <h3 className="m-0 text-meta font-medium text-fg-subtle">{group}</h3>}
          <ul className="m-0 grid list-none grid-cols-2 gap-1.5 p-0">
            {detail.scans
              .filter((s) => groupOf(s, grouped) === group)
              .map((s) => (
                <li key={s.scan.inputId}>
                  <ScanTile scan={s} />
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function ScanTile({ scan }: { scan: StudyScanDetail }) {
  const { label, tone } = scanStatus(scan);
  const side = scan.scan.attributes.side;
  const body = (
    <>
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-ui">{scan.scan.subject}</span>
        {typeof side === "string" && <span className="text-meta text-fg-subtle">{side}</span>}
      </span>
      <StatusBadge tone={tone}>{label}</StatusBadge>
    </>
  );
  const path = runPath(scan);
  const tile = "grid h-full gap-1.5 rounded-lg border border-border bg-card px-3 py-2";
  return path ? (
    <Link to={path} className={`${tile} hover:bg-accent`}>
      {body}
    </Link>
  ) : (
    <div className={tile}>{body}</div>
  );
}
