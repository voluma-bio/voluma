/**
 * The workflow as a graph of real nodes: one box per task, laid out by dependency depth, with an
 * edge for each dependency no longer path already implies. One component in three sizes:
 * - `study`: left to right; each box sums the study's scans, one cell per scan, then counts.
 *   Its boxes share the graph's width down to `STUDY_BOX`, so a six-layer workflow fits a page
 *   column beside the Study panel at 1280 px.
 * - `summary`: left to right and small; one scan's tasks, each with its state and one line.
 * - `report`: top down, fitted to the scan review's Report panel: a layer wider than the panel
 *   wraps onto more rows. The selected, working or redone task also lists its agents.
 * A box either opens somewhere (`taskLink`, a link) or picks a task in place (`onSelect`, a toggle).
 * Boxes are ordinary layout and may grow; the edges are measured from where the boxes are after
 * layout, so the drawing never needs to know a box's size.
 */
import { cx, type LinkTo, Progress, STATUS_WORD, type Status, StatusGlyph } from "@voluma/ui";
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { THREAD_STATUS } from "./agents";
import { agentLabel, type TaskState, type TaskView, type Thread } from "./run-model";

/** One task as the graph places it. */
export type GraphTask = { id: string; title: string; dependsOn: string[] };

/** A task at study size: its state on each scan of the study, in the study's scan order. */
export type StudyGraphTask = GraphTask & { scans: Status[] };

/**
 * What a box at scan size needs of a task; the report size also lists its `threads`. `open`: its
 * items still open for a person, as the scan review counts them (`openItems`, review-state.ts).
 */
export type ScanGraphTask = Pick<TaskView, "id" | "title" | "dependsOn" | "state" | "results"> & {
  open: number;
} & Partial<Pick<TaskView, "threads">>;

export type TaskGraphProps =
  | {
      size: "study";
      tasks: StudyGraphTask[];
      /** The task the page is filtered to; its edges light up. */
      selected?: string;
      /** Picks a task on this page: the box is a toggle, pressed when `selected`. */
      onSelect?: (taskId: string) => void;
      /** Where a box opens, when it leads to another page: the box is a link. */
      taskLink?: (taskId: string) => LinkTo;
      className?: string;
    }
  | {
      size: "summary" | "report";
      tasks: ScanGraphTask[];
      selected?: string;
      onSelect?: (taskId: string) => void;
      /** Report size: opens one of a box's agents. */
      onAgent?: (threadId: string) => void;
      className?: string;
    };

/** A task's state in the one status vocabulary of `@voluma/ui`; skipped reads as waiting. */
export const TASK_STATUS: Record<TaskState, Status> = {
  waiting: "waiting",
  ready: "waiting",
  running: "running",
  checking: "checking",
  held: "waiting",
  done: "done",
  "to-check": "check",
  failed: "stopped",
  stopped: "stopped",
  paused: "paused",
  skipped: "waiting",
};

/**
 * The one rule for the status a task shows, from its state and its open items (`openItems`,
 * review-state.ts). Open items read To check while the task is done or in To check: a done task
 * can still carry them. A To check task with every item handled reads done.
 */
export function shownStatus(state: TaskState, open: number): Status {
  if (open > 0 && (state === "done" || state === "to-check")) return "check";
  if (state === "to-check") return "done";
  return TASK_STATUS[state];
}

/** Where a state is more exact than its mark's word. */
const STATE_WORD: Partial<Record<TaskState, string>> = {
  ready: "Ready to start",
  held: "Waiting on the lead AI",
  failed: "Failed",
  skipped: "Skipped",
};

/** A task's state in a word: STATUS_WORD's, with the states that word would blur named. */
export const taskStateWord = (state: TaskState) =>
  STATE_WORD[state] ?? STATUS_WORD[TASK_STATUS[state]];

/**
 * A box's least width: the longest workflow names ("Proximal tibial metaphysis", "Subchondral
 * bone plate") fit on two lines, breaking only between words.
 */
const BOX_REM = 9.5;
const BOX = `${BOX_REM}rem`;
/**
 * A study box's least width: narrower than `BOX`, so the mouse OA workflow's six layers fit 784 px
 * (6 x 108 px boxes, 5 x 16 px gaps). A long name takes a third line there.
 */
const STUDY_BOX = "6.75rem";
/** The gap between top-down lanes, `gap-2`. */
const LANE_GAP_REM = 0.5;

/**
 * How many lanes of `BOX` fit the graph's own width, at most `lanes`: a top-down layer wider than
 * its panel wraps onto more rows instead of running off the edge. Off (`lanes` as is) for a
 * left-to-right graph, whose layers are columns.
 */
function useFit(lanes: number, on: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(lanes);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    const measure = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const n = Math.floor(
        (el.clientWidth + LANE_GAP_REM * rem) / ((BOX_REM + LANE_GAP_REM) * rem),
      );
      setFit(Math.max(1, Math.min(lanes, n)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [lanes, on]);
  return { ref, fit: on ? fit : lanes };
}

export function TaskGraph(props: TaskGraphProps) {
  const right = props.size !== "report";
  const boxes = new Map<string, ReactNode>(
    props.size === "study"
      ? props.tasks.map((t) => [
          t.id,
          <StudyBox
            key={t.id}
            task={t}
            pressed={props.selected === t.id}
            onSelect={props.onSelect}
            link={props.taskLink?.(t.id)}
          />,
        ])
      : props.tasks.map((t) => [
          t.id,
          <ScanBox
            key={t.id}
            task={t}
            size={props.size}
            selected={props.selected === t.id}
            onSelect={props.onSelect}
            onAgent={props.size === "report" ? props.onAgent : undefined}
          />,
        ]),
  );
  const { layers, edges, lanes: all } = layout<GraphTask>(props.tasks);
  const { ref, paths } = useEdges(edges, right);
  const { ref: outer, fit: lanes } = useFit(all, !right);
  return (
    // Boxes keep their least width; a parent narrower than one box, or than a left-to-right
    // graph's layers (a study workflow of 7 or more layers beside the Study panel), scrolls here.
    <div ref={outer} className={cx("overflow-x-auto", props.className)}>
      <div
        ref={ref}
        className={cx(
          "relative grid",
          right
            ? cx(
                "auto-cols-[minmax(var(--box),1fr)] grid-flow-col",
                props.size === "study" ? "gap-x-4" : "gap-x-6",
              )
            : "gap-y-4 [&>[data-layer]]:grid [&>[data-layer]]:grid-cols-[repeat(var(--lanes),minmax(var(--box),1fr))] [&>[data-layer]]:items-start [&>[data-layer]]:gap-2",
        )}
        style={
          { "--lanes": lanes, "--box": props.size === "study" ? STUDY_BOX : BOX } as CSSProperties
        }
      >
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
        >
          {paths.map((p) => (
            <path
              key={p.key}
              d={p.d}
              className={cx(
                "fill-none",
                props.selected && (p.from === props.selected || p.to === props.selected)
                  ? "stroke-select stroke-[1.5]"
                  : "stroke-line-strong stroke-[1.25]",
              )}
            />
          ))}
        </svg>
        {layers.map((layer) => (
          <div
            key={layer[0]?.id}
            data-layer
            className={right ? "grid content-center gap-y-2.5" : undefined}
          >
            {layer.map((task) => (
              <div
                key={task.id}
                data-node={task.id}
                className={cx(
                  // A lone task in a top-down layer sits centred at one lane's width.
                  !right &&
                    layer.length === 1 &&
                    lanes > 1 &&
                    "col-span-full w-[calc((100%-0.5rem)/2)] justify-self-center",
                )}
              >
                {boxes.get(task.id)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The layers by dependency depth, each ordered under its parents' mean position (plan order
 * breaks ties), and the edges a longer path doesn't already imply.
 */
function layout<T extends GraphTask>(tasks: T[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const parents = (t: GraphTask) => t.dependsOn.filter((p) => byId.has(p));
  const depth = new Map<string, number>();
  const depthOf = (t: GraphTask): number => {
    const known = depth.get(t.id);
    if (known !== undefined) return known;
    depth.set(t.id, 0); // a cycle (the plan refuses them) would stop here
    const d = Math.max(0, ...parents(t).map((p) => 1 + depthOf(byId.get(p) as GraphTask)));
    depth.set(t.id, d);
    return d;
  };
  const layers: T[][] = [];
  for (const t of tasks) {
    const d = depthOf(t);
    layers[d] = [...(layers[d] ?? []), t];
  }
  const dense = layers.filter(Boolean);
  const at = new Map<string, number>();
  for (const layer of dense) {
    const mean = (t: GraphTask) => {
      const ps = parents(t).map((p) => at.get(p) ?? 0);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
    };
    const order = new Map(tasks.map((t, i) => [t.id, i]));
    layer.sort((a, b) => mean(a) - mean(b) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    layer.forEach((t, i) => {
      at.set(t.id, (i + 0.5) / layer.length);
    });
  }
  const reaches = (from: string, to: string): boolean => {
    const t = byId.get(to);
    return t ? parents(t).some((p) => p === from || reaches(from, p)) : false;
  };
  const edges = tasks.flatMap((t) => {
    const ps = parents(t);
    return ps
      .filter((p) => !ps.some((o) => o !== p && reaches(p, o)))
      .map((p) => ({ from: p, to: t.id }));
  });
  return { layers: dense, edges, lanes: Math.max(1, ...dense.map((l) => l.length)) };
}

type Edge = { from: string; to: string };
type DrawnEdge = Edge & { key: string; d: string };

/** The edges as paths between the boxes' measured offsets, redrawn whenever the graph resizes. */
function useEdges(edges: Edge[], right: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<DrawnEdge[]>([]);
  const key = edges.map((e) => `${e.from}>${e.to}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `edges`, a new array each render.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const draw = () => {
      // Offsets within the graph, not screen rects, so a scaled graph's edges still meet its boxes.
      const box = (id: string) => {
        const el = root.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`);
        if (!el) return undefined;
        let x = 0;
        let y = 0;
        for (let n: HTMLElement | null = el; n && n !== root; n = n.offsetParent as HTMLElement) {
          x += n.offsetLeft;
          y += n.offsetTop;
        }
        // The layer it sits in, for a top-down layer wrapped onto more rows.
        const layer = el.parentElement as HTMLElement;
        return {
          x,
          y,
          w: el.offsetWidth,
          h: el.offsetHeight,
          top: layer.offsetTop,
          bottom: layer.offsetTop + layer.offsetHeight,
        };
      };
      // A wrapped row's box can't be reached straight down without passing behind the row above
      // it (or leave straight down past the row below): its edge runs in the gutter beside it, on
      // its left, or on its right in the first column, and meets its side.
      const gap =
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * LANE_GAP_REM;
      const gutter = (b: { x: number; w: number }) =>
        b.x > gap ? b.x - gap / 2 : b.x + b.w + gap / 2;
      const side = (b: { x: number; w: number }) => (b.x > gap ? b.x : b.x + b.w);
      setPaths(
        edges.flatMap((e) => {
          const a = box(e.from);
          const b = box(e.to);
          if (!a || !b) return [];
          let d: string;
          if (right) {
            const [x1, y1, x2, y2] = [a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2];
            const m = (x1 + x2) / 2;
            d = `M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}`;
          } else {
            const fromLast = a.y + a.h >= a.bottom - 1;
            const toFirst = b.y <= b.top + 1;
            const [x1, y1] = fromLast ? [a.x + a.w / 2, a.y + a.h] : [gutter(a), a.bottom];
            const [x2, y2] = toFirst ? [b.x + b.w / 2, b.y] : [gutter(b), b.top];
            const m = (y1 + y2) / 2;
            d = [
              fromLast
                ? `M${x1} ${y1}`
                : `M${side(a)} ${a.y + a.h / 2} L${x1} ${a.y + a.h / 2} L${x1} ${y1}`,
              `C${x1} ${m} ${x2} ${m} ${x2} ${y2}`,
              toFirst ? "" : `L${x2} ${b.y + b.h / 2} L${side(b)} ${b.y + b.h / 2}`,
            ].join(" ");
          }
          return [{ ...e, key: `${e.from}>${e.to}`, d }];
        }),
      );
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(root);
    for (const el of root.querySelectorAll("[data-node]")) observer.observe(el);
    return () => observer.disconnect();
  }, [key, right]);
  return { ref, paths };
}

/**
 * A box: a titled surface whose title is its one control, stretched over the box, so buttons
 * inside it (a box's agents) stay clickable above it without nesting controls.
 */
function Box({
  title,
  label,
  selected,
  pressed,
  dim,
  compact,
  onSelect,
  link,
  lead,
  children,
}: {
  title: string;
  /** The control's accessible name; the box's text says it to sighted readers. */
  label: string;
  selected?: boolean;
  pressed?: boolean;
  dim?: boolean;
  compact?: boolean;
  onSelect?: () => void;
  link?: LinkTo;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "relative grid min-w-0 gap-0.5 rounded-lg bg-card text-left",
        compact ? "px-2 pt-1.5 pb-[7px]" : "px-2.5 pt-[7px] pb-2",
        selected || pressed
          ? "inset-ring-[1.5px] inset-ring-select"
          : dim
            ? "inset-ring inset-ring-border"
            : "inset-ring inset-ring-line-strong",
        pressed && "bg-select-tint",
        onSelect && "has-[[data-box-control]:hover]:bg-accent",
        // A link's stretched target covers the box, so hovering the box is hovering the link.
        link && "hover:bg-accent",
      )}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        {lead && <span className="mt-0.5 flex">{lead}</span>}
        {link ? (
          <BoxLink to={link} label={label} dim={dim}>
            {title}
          </BoxLink>
        ) : onSelect ? (
          <button
            type="button"
            data-box-control
            aria-label={label}
            aria-current={selected || undefined}
            aria-pressed={pressed === undefined ? undefined : pressed}
            onClick={onSelect}
            className={cx(CONTROL, dim && "text-muted-foreground")}
          >
            {title}
          </button>
        ) : (
          <span
            className={cx(
              "min-w-0 flex-1 text-sm leading-snug font-medium hyphens-none [text-wrap:balance]",
              dim && "text-muted-foreground",
            )}
          >
            {title}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** A box's title as its control: the whole box is the target, through a stretched `after`. */
const CONTROL = cx(
  "min-w-0 flex-1 cursor-pointer text-left text-sm leading-snug font-medium hyphens-none [text-wrap:balance]",
  "after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-1 focus-visible:after:outline-ring",
);

/** A box's title as a link: a plain URL, or the app's router link given the box's look. */
function BoxLink({
  to,
  label,
  dim,
  children,
}: {
  to: LinkTo;
  label: string;
  dim?: boolean;
  children: ReactNode;
}) {
  const className = cx(CONTROL, dim && "text-muted-foreground");
  // A router link passes on only its props, so the accessible name is text, not `aria-label`.
  const body = (
    <>
      <span className="sr-only">{label}</span>
      <span aria-hidden>{children}</span>
    </>
  );
  return typeof to === "string" ? (
    <a href={to} className={className}>
      {body}
    </a>
  ) : (
    to({ className, children: body, "data-row-control": "" })
  );
}

const COUNT_ORDER: { status: Status; word: string; tone?: string }[] = [
  { status: "done", word: "done" },
  { status: "check", word: "to check", tone: "font-medium text-check" },
  { status: "running", word: "running", tone: "text-info" },
  { status: "checking", word: "checking", tone: "text-info" },
  { status: "stopped", word: "stopped", tone: "text-destructive" },
  { status: "paused", word: "paused" },
  { status: "waiting", word: "waiting" },
];

function StudyBox({
  task,
  pressed,
  onSelect,
  link,
}: {
  task: StudyGraphTask;
  pressed: boolean;
  onSelect?: (taskId: string) => void;
  link?: LinkTo;
}) {
  const counts = COUNT_ORDER.map((c) => ({
    ...c,
    n: task.scans.filter((s) => s === c.status).length,
  })).filter((c) => c.n > 0);
  const summary = counts.map((c) => `${c.n} ${c.word}`).join(", ");
  return (
    <Box
      title={task.title}
      label={`${task.title}: ${summary || "no scans"}`}
      pressed={onSelect ? pressed : undefined}
      onSelect={onSelect && (() => onSelect(task.id))}
      link={link}
    >
      <Progress states={task.scans} className="my-0.5" />
      <p className="flex flex-wrap gap-x-2.5 text-xs leading-4 text-muted-foreground">
        {counts.map((c) => (
          <span key={c.status} className={c.tone}>
            {c.n} {c.word}
          </span>
        ))}
      </p>
    </Box>
  );
}

/** A box's one line at scan size: what needs you, what is going on, or its key value. */
function scanLine(task: ScanGraphTask, open: number): { text: ReactNode; tone?: string } {
  if (shownStatus(task.state, open) === "check" && open > 0)
    return { text: `${open} to check`, tone: "font-medium text-check" };
  switch (task.state) {
    case "running":
      return { text: "Running", tone: "text-info" };
    case "checking":
      return { text: "Second check", tone: "text-info" };
    case "failed":
    case "stopped":
      return { text: taskStateWord(task.state), tone: "text-destructive" };
    case "done":
    case "to-check":
      return keyValue(task);
    default:
      return { text: taskStateWord(task.state) };
  }
}

/** Its first value with its unit, the way a Readout reads it; "Done" when it reports none. */
function keyValue(task: ScanGraphTask): { text: ReactNode } {
  const r = task.results.find((x) => x.value !== null);
  if (!r) return { text: "Done" };
  return {
    text: (
      <>
        <span className="font-mono text-foreground/80 tabular-nums">{r.value}</span>
        {r.unit && ` ${r.unit}`}
        <span className="sr-only">, {r.title}</span>
      </>
    ),
  };
}

function ScanBox({
  task,
  size,
  selected,
  onSelect,
  onAgent,
}: {
  task: ScanGraphTask;
  size: "summary" | "report";
  selected: boolean;
  onSelect?: (taskId: string) => void;
  onAgent?: (threadId: string) => void;
}) {
  const { open } = task;
  const status = shownStatus(task.state, open);
  const line = scanLine(task, open);
  const idle = task.state === "waiting" || task.state === "ready" || task.state === "skipped";
  const threads = task.threads ?? [];
  const attempts = Math.max(0, ...threads.map((t) => t.attempts.length));
  const grow =
    size === "report" &&
    threads.length > 0 &&
    (selected || task.state === "running" || task.state === "checking" || attempts > 1);
  return (
    <Box
      title={task.title}
      label={`${task.title}: ${typeof line.text === "string" ? line.text : taskStateWord(task.state)}`}
      selected={selected}
      dim={idle}
      compact={size === "summary"}
      onSelect={onSelect && (() => onSelect(task.id))}
      lead={<StatusGlyph status={status} />}
    >
      <p
        className={cx(
          "truncate pl-5 text-xs leading-4 text-muted-foreground",
          task.state === "skipped" && "italic",
          line.tone,
        )}
      >
        {line.text}
      </p>
      {grow && <AgentRows threads={threads} onAgent={onAgent} />}
    </Box>
  );
}

/** A box's agents, as the Agents panel names them, each opening there. */
function AgentRows({
  threads,
  onAgent,
}: {
  threads: Thread[];
  onAgent?: (threadId: string) => void;
}) {
  return (
    <ul className="relative z-[1] mt-1 -mr-1.5 -ml-1 grid border-t border-border pt-1">
      {threads.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            disabled={!onAgent}
            onClick={() => onAgent?.(t.id)}
            className="grid min-h-[22px] w-full cursor-pointer grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-x-1.5 rounded-sm px-1 py-[3px] text-left text-xs leading-4 hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
          >
            <StatusGlyph status={THREAD_STATUS[t.status]} className="mt-0.5 size-3" />
            {/* A narrow box wraps the name between words rather than cutting it. */}
            <span className="hyphens-none">{agentLabel(t, threads, { short: true })}</span>
            <AgentOutcome thread={t} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function AgentOutcome({ thread }: { thread: Thread }) {
  const verdict = thread.result?.verdict;
  if (verdict === "needs-review") return <span className="text-check">Sent back</span>;
  if (verdict === "passed") return <span className="text-muted-foreground">Agreed</span>;
  if (thread.status === "failed") return <span className="text-destructive">Failed</span>;
  if (thread.status === "running") return <span className="text-info">Running</span>;
  return <span className="text-muted-foreground">{STATUS_WORD[THREAD_STATUS[thread.status]]}</span>;
}
