/**
 * The plan as a dependency graph: columns by depth, an edge from each task to what builds on it.
 * Node state shows what is running, waiting and done at a glance; a node opens the task's newest
 * thread, and hovering one lights its threads in the lanes and the feed.
 */
import type { WorkflowPlan } from "@voluma/contracts/workflow";
import { Link } from "react-router";
import { threadHref } from "./feed";
import { layoutPlan, type TaskState, type Thread } from "./run-feed";
import { taskTitle } from "./workflows";

const W = 168;
const H = 44;
const GAP_X = 36;
const GAP_Y = 10;

const STATE: Record<TaskState, { label: string; node: string; dot: string }> = {
  running: {
    label: "Working",
    node: "border-info bg-info-tint text-info",
    dot: "bg-info animate-pulse",
  },
  checking: {
    label: "Being checked",
    node: "border-info bg-info-tint text-info",
    dot: "bg-info animate-pulse",
  },
  done: {
    label: "Done",
    node: "border-primary/40 bg-primary-tint text-primary-strong",
    dot: "bg-primary",
  },
  "to-check": {
    label: "To check",
    node: "border-check-line bg-check-tint text-check-strong",
    dot: "bg-check-solid",
  },
  failed: {
    label: "Failed",
    node: "border-destructive/40 bg-destructive-tint text-destructive",
    dot: "bg-destructive",
  },
  ready: {
    label: "Ready",
    node: "border-border bg-card text-foreground",
    dot: "border border-line-strong bg-card",
  },
  waiting: {
    label: "Waiting",
    node: "border-border bg-muted text-muted-foreground",
    dot: "bg-line-strong",
  },
};

export function TaskGraph({
  plan,
  states,
  threadByTask,
  openThread,
  hover,
  onHover,
}: {
  plan: WorkflowPlan;
  states: Map<string, TaskState>;
  threadByTask: Map<string, Thread>;
  openThread: string | null;
  hover: string | null;
  onHover: (task: string | null) => void;
}) {
  const nodes = layoutPlan(plan);
  const at = new Map(
    nodes.map((n) => [n.id, { x: n.level * (W + GAP_X), y: n.row * (H + GAP_Y) }]),
  );
  const width = (Math.max(...nodes.map((n) => n.level)) + 1) * (W + GAP_X) - GAP_X;
  const height = (Math.max(...nodes.map((n) => n.row)) + 1) * (H + GAP_Y) - GAP_Y;
  const hovered = nodes.find((n) => n.id === hover);
  const related = (id: string) =>
    hover === null ||
    id === hover ||
    hovered?.dependsOn.includes(id) ||
    nodes.some((n) => n.id === id && n.dependsOn.includes(hover));
  const done = [...states.values()].filter((s) => s === "done").length;

  return (
    <nav aria-label="Tasks">
      <h2 className="mb-2 flex items-baseline gap-3 text-ui font-medium">
        Tasks
        <span className="font-normal text-muted-foreground">
          {done} of {nodes.length} done
        </span>
      </h2>
      <div className="overflow-x-auto pb-1">
        <div className="relative" style={{ width, height }}>
          <svg
            width={width}
            height={height}
            className="absolute inset-0 text-line-strong"
            aria-hidden="true"
          >
            {nodes.flatMap((n) =>
              n.dependsOn.map((d) => {
                const from = at.get(d);
                const to = at.get(n.id);
                if (!from || !to) return null;
                const x1 = from.x + W;
                const y1 = from.y + H / 2;
                const x2 = to.x;
                const y2 = to.y + H / 2;
                const mid = (x1 + x2) / 2;
                const lit = hover !== null && (hover === n.id || hover === d);
                return (
                  <path
                    key={`${d}>${n.id}`}
                    d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={lit ? 2 : 1.25}
                    className={lit ? "text-foreground" : undefined}
                    opacity={hover === null || lit ? 1 : 0.35}
                  />
                );
              }),
            )}
          </svg>
          {nodes.map((n) => {
            const state = states.get(n.id) ?? "waiting";
            const s = STATE[state];
            const thread = threadByTask.get(n.id);
            const pos = at.get(n.id);
            const cls = `absolute flex flex-col justify-center rounded-lg border px-2.5 transition-opacity ${s.node} ${
              related(n.id) ? "" : "opacity-40"
            }`;
            const body = (
              <>
                <span className="truncate text-ui font-medium leading-tight">
                  {taskTitle(n.id)}
                </span>
                <span className="flex items-center gap-1.5 text-meta leading-tight opacity-90">
                  <span className={`size-2 rounded-full ${s.dot}`} aria-hidden="true" />
                  {s.label}
                </span>
              </>
            );
            const props = {
              style: { left: pos?.x, top: pos?.y, width: W, height: H },
              onMouseEnter: () => onHover(n.id),
              onMouseLeave: () => onHover(null),
            };
            return thread ? (
              <Link
                key={n.id}
                to={threadHref(thread.id)}
                aria-current={thread.id === openThread ? "true" : undefined}
                className={`${cls} aria-[current]:ring-2 aria-[current]:ring-primary`}
                {...props}
              >
                {body}
              </Link>
            ) : (
              <div key={n.id} className={cls} {...props}>
                {body}
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
