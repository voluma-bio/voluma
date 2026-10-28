/**
 * The plan as a compact dependency graph, top to bottom: one row per dependency depth, an edge
 * from each task to what builds on it. Secondary to the transcript, so it is small: a state dot
 * and a short title per task, the full name and state on hover. A task opens its newest thread.
 */
import type { WorkflowPlan } from "@voluma/contracts/workflow";
import { useOpenThread } from "./chat/thread-navigation";
import { layoutPlan, type TaskState, type Thread } from "./run-model";
import { taskTitle } from "./workflows";

/** The rail's inner width; nodes share it, up to a comfortable maximum. */
const SPACE = 328;
const MAX_W = 150;
const H = 28;
const GAP_X = 8;
const GAP_Y = 16;

const STATE: Record<TaskState, { label: string; node: string; dot: string }> = {
  running: {
    label: "Working",
    node: "border-info bg-info-tint",
    dot: "bg-info motion-safe:animate-pulse",
  },
  checking: {
    label: "Being checked",
    node: "border-info bg-info-tint",
    dot: "bg-info motion-safe:animate-pulse",
  },
  done: { label: "Done", node: "border-primary/40 bg-primary-tint", dot: "bg-primary" },
  "to-check": { label: "To check", node: "border-check-line bg-check-tint", dot: "bg-check-solid" },
  failed: {
    label: "Failed",
    node: "border-destructive/40 bg-destructive-tint",
    dot: "bg-destructive",
  },
  stopped: {
    label: "Stopped",
    node: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  paused: {
    label: "Paused",
    node: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  ready: {
    label: "Ready",
    node: "border-border bg-card",
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
}: {
  plan: WorkflowPlan;
  states: Map<string, TaskState>;
  threadByTask: Map<string, Thread>;
}) {
  const open = useOpenThread();
  const nodes = layoutPlan(plan);
  const perLevel = new Map<number, number>();
  for (const n of nodes) perLevel.set(n.level, (perLevel.get(n.level) ?? 0) + 1);
  const columns = Math.max(...perLevel.values());
  const W = Math.min(MAX_W, Math.floor((SPACE - (columns - 1) * GAP_X) / columns));
  const width = columns * (W + GAP_X) - GAP_X;
  const height = (Math.max(...nodes.map((n) => n.level)) + 1) * (H + GAP_Y) - GAP_Y;
  // Each depth's tasks are centred in the row.
  const at = new Map(
    nodes.map((n) => {
      const count = perLevel.get(n.level) ?? 1;
      const offset = ((columns - count) * (W + GAP_X)) / 2;
      return [n.id, { x: offset + n.row * (W + GAP_X), y: n.level * (H + GAP_Y) }];
    }),
  );

  return (
    <div className="relative mx-auto" style={{ width, height }}>
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
            const x1 = from.x + W / 2;
            const y1 = from.y + H;
            const x2 = to.x + W / 2;
            const y2 = to.y;
            const mid = (y1 + y2) / 2;
            return (
              <path
                key={`${d}>${n.id}`}
                d={`M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.25}
              />
            );
          }),
        )}
      </svg>
      {nodes.map((n) => {
        const s = STATE[states.get(n.id) ?? "waiting"];
        const thread = threadByTask.get(n.id);
        const pos = at.get(n.id);
        const name = `${taskTitle(n.id)}: ${s.label}`;
        const cls = `absolute flex items-center gap-1.5 rounded-md border px-2 text-meta ${s.node}`;
        const style = { left: pos?.x, top: pos?.y, width: W, height: H };
        const body = (
          <>
            <span className={`size-2 shrink-0 rounded-full ${s.dot}`} aria-hidden="true" />
            <span className="min-w-0 truncate">{taskTitle(n.id)}</span>
            <span className="sr-only">: {s.label}</span>
          </>
        );
        return thread ? (
          <button
            key={n.id}
            type="button"
            title={name}
            onClick={() => open(thread.id)}
            className={`${cls} text-left hover:border-line-strong hover:shadow-sm`}
            style={style}
          >
            {body}
          </button>
        ) : (
          <div key={n.id} title={name} className={cls} style={style}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
