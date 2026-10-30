/**
 * The run's tasks as a flowchart from the plan's `dependsOn`: one row per dependency depth, each
 * row ordered by where its parents sit so edges cross as little as the plan allows, every node
 * showing its state and opening its task. Overview sits above it. Below 1100 px it is a compact
 * list. State words and marks are shared with the rest of the page (`TaskMark`, `STATE_WORD`).
 */
import { cx } from "@voluma/ui";
import { ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import type { TaskState, TaskView } from "./run-model";

export const STATE_WORD: Record<TaskState, string> = {
  waiting: "Not started",
  ready: "Ready to start",
  running: "Working",
  checking: "A second AI is checking",
  done: "Done",
  "to-check": "To check",
  skipped: "Skipped",
  failed: "Failed",
  stopped: "Stopped",
  paused: "Paused",
};

/** A task's state as a small mark: hollow until it starts, spinning while it works, filled once it ends. */
export function TaskMark({ state, className }: { state: TaskState; className?: string }) {
  const base = cx("inline-block size-2.5 shrink-0 rounded-full", className);
  switch (state) {
    case "running":
      return (
        <span
          aria-hidden
          className={cx(
            base,
            "size-3 border-2 border-info-tint border-t-info motion-safe:animate-spin",
          )}
        />
      );
    case "checking":
      return (
        <ShieldCheck
          aria-hidden
          className={cx("size-3.5 shrink-0 text-info motion-safe:animate-pulse", className)}
        />
      );
    case "done":
      return <span aria-hidden className={cx(base, "bg-primary")} />;
    case "to-check":
      return <span aria-hidden className={cx(base, "bg-check-solid")} />;
    case "failed":
      return <span aria-hidden className={cx(base, "bg-destructive")} />;
    case "stopped":
    case "paused":
      return <span aria-hidden className={cx(base, "bg-muted-foreground")} />;
    case "skipped":
      return (
        <span aria-hidden className={cx(base, "border-[1.5px] border-dashed border-line-strong")} />
      );
    default:
      return <span aria-hidden className={cx(base, "border-[1.5px] border-line-strong")} />;
  }
}

const NOT_STARTED: ReadonlySet<TaskState> = new Set(["waiting", "ready", "skipped"]);

/** Where each task sits: its row is its dependency depth, its column its order in the row. */
function layout(tasks: TaskView[]) {
  const ids = new Set(tasks.map((t) => t.id));
  const depth = new Map<string, number>();
  const depthOf = (t: TaskView): number => {
    const known = depth.get(t.id);
    if (known !== undefined) return known;
    depth.set(t.id, 0); // a cycle (the plan refuses them) would stop here
    const d = Math.max(
      0,
      ...t.dependsOn
        .filter((p) => ids.has(p))
        .map((p) => 1 + depthOf(tasks.find((x) => x.id === p) as TaskView)),
    );
    depth.set(t.id, d);
    return d;
  };
  const rows: TaskView[][] = [];
  for (const t of tasks) {
    const d = depthOf(t);
    rows[d] = [...(rows[d] ?? []), t];
  }
  // Each row ordered by its parents' mean column, so edges run as straight as they can.
  const column = new Map<string, number>();
  for (const row of rows) {
    const mean = (t: TaskView) => {
      const cols = t.dependsOn.flatMap((p) => column.get(p) ?? []);
      return cols.length ? cols.reduce((a, b) => a + b, 0) / cols.length : 0;
    };
    row.sort((a, b) => mean(a) - mean(b) || a.number - b.number);
    const width = Math.max(...rows.map((r) => r.length));
    row.forEach((t, i) => {
      column.set(t.id, i + (width - row.length) / 2);
    });
  }
  return { rows, column, depth, width: Math.max(1, ...rows.map((r) => r.length)) };
}

const NODE_H = 50;
const ROW_GAP = 22;
const COL_GAP = 6;
/** The flowchart's width inside the 320 px column. */
const WIDTH = 296;

export function TaskFlow({
  tasks,
  selected,
  search,
}: {
  tasks: TaskView[];
  /** The open task; none is Overview. */
  selected?: string;
  /** The page's other search params, kept when a node is opened. */
  search: (taskId?: string) => string;
}) {
  const { rows, column, depth, width } = layout(tasks);
  const nodeW = (WIDTH - (width - 1) * COL_GAP) / width;
  const x = (id: string) => (column.get(id) ?? 0) * (nodeW + COL_GAP);
  const y = (id: string) => (depth.get(id) ?? 0) * (NODE_H + ROW_GAP);
  const height = rows.length * NODE_H + (rows.length - 1) * ROW_GAP;
  return (
    <>
      <nav
        aria-label="Tasks"
        className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-background px-3 pt-4 pb-16 max-[1100px]:hidden"
      >
        <OverviewLink selected={!selected} to={search()} />
        <div className="relative mx-auto" style={{ width: WIDTH, height }}>
          <svg
            aria-hidden
            className="absolute inset-0 overflow-visible"
            width={WIDTH}
            height={height}
          >
            {tasks.flatMap((t) =>
              t.dependsOn
                .filter((p) => column.has(p))
                .map((p) => {
                  const x1 = x(p) + nodeW / 2;
                  const y1 = y(p) + NODE_H;
                  const x2 = x(t.id) + nodeW / 2;
                  const y2 = y(t.id);
                  const my = (y1 + y2) / 2;
                  return (
                    <path
                      key={`${p}>${t.id}`}
                      d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`}
                      className="fill-none stroke-line-strong"
                      strokeWidth={1.5}
                    />
                  );
                }),
            )}
          </svg>
          <ol>
            {tasks.map((t) => (
              <li
                key={t.id}
                className="absolute"
                style={{ left: x(t.id), top: y(t.id), width: nodeW, height: NODE_H }}
              >
                <Link
                  to={search(t.id)}
                  title={`${t.title}: ${STATE_WORD[t.state]}`}
                  aria-current={selected === t.id ? "page" : undefined}
                  className={cx(
                    "relative flex h-full items-center justify-center rounded-lg border bg-card px-1.5 text-center text-[0.6875rem] leading-tight font-medium shadow-xs hover:border-primary",
                    selected === t.id ? "border-primary ring-1 ring-primary" : "border-border",
                    t.state === "skipped" && "border-dashed bg-muted",
                    NOT_STARTED.has(t.state) ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  <TaskMark
                    state={t.state}
                    className="absolute -top-1 -left-1 rounded-full ring-2 ring-background"
                  />
                  <span className="line-clamp-3 min-w-0 hyphens-auto [text-wrap:balance]">
                    {t.title}
                  </span>
                  <span className="sr-only">: {STATE_WORD[t.state]}</span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </nav>
      <nav
        aria-label="Tasks"
        className="hidden border-b border-border px-4 py-3 max-[1100px]:block"
      >
        <ol className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-1">
          <li>
            <OverviewLink selected={!selected} to={search()} />
          </li>
          {tasks.map((t) => (
            <li key={t.id}>
              <Link
                to={search(t.id)}
                aria-current={selected === t.id ? "page" : undefined}
                className={cx(
                  "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-ui hover:bg-accent",
                  selected === t.id && "bg-card font-medium shadow-[inset_0_0_0_1px_var(--border)]",
                  NOT_STARTED.has(t.state) && "text-muted-foreground",
                )}
              >
                <TaskMark state={t.state} />
                <span className="min-w-0 truncate">{t.title}</span>
                <span className="sr-only">: {STATE_WORD[t.state]}</span>
              </Link>
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}

function OverviewLink({ selected, to }: { selected: boolean; to: string }) {
  return (
    <Link
      to={to}
      aria-current={selected ? "page" : undefined}
      className={cx(
        "block w-full rounded-lg px-3 py-2 text-ui font-medium hover:bg-accent max-[1100px]:px-2 max-[1100px]:py-1.5",
        selected && "bg-card shadow-[inset_0_0_0_1px_var(--border)]",
      )}
    >
      Overview
    </Link>
  );
}
