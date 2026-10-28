/**
 * One transcript, the page's only scroller: the rows from `transcript.ts` rendered the way
 * Meridian Flow renders an assistant turn, with Flow's follow scroll and "Scroll to latest" pill.
 * Prose stays visible; process folds stay closed until the reader opens them; a running thread
 * ends in a live line naming what it is doing.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { StatusBadge } from "@voluma/ui";
import {
  ArrowDown,
  Brain,
  Cog,
  Flag,
  Image,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  PackageCheck,
  Terminal,
  Wand,
  Workflow,
} from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { AgentCard } from "./agents";
import { ActivityRow } from "./chat/activity-row";
import { InfoButton, usageRows } from "./chat/info-button";
import { ClampedMarkdown, Markdown, StreamingText } from "./chat/markdown";
import { ProcessDisclosure } from "./chat/process-disclosure";
import { useFollowScroll } from "./chat/use-follow-scroll";
import type { Thread } from "./run-model";
import type { Row, Step, ToolStep } from "./transcript";
import { taskTitle } from "./workflows";

type Wake = Extract<RunEvent, { type: "wake" }>;

export function TranscriptView({
  rows,
  threads,
  live,
  empty,
}: {
  rows: Row[];
  threads: Map<string, Thread>;
  /** While the thread works: what it is doing now, for the live line at the end. */
  live?: string | null;
  empty: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  // Folds opening and text growing change the height without changing `rows`.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setContentHeight(el.offsetHeight));
    observer.observe(el);
    setContentHeight(el.offsetHeight);
    return () => observer.disconnect();
  }, []);
  const { mode, enterFollow } = useFollowScroll({ scrollRef, contentHeight });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        // Focusable so the keyboard can scroll it (and so ArrowUp/PageUp release follow).
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto outline-none [overflow-anchor:none]"
      >
        <div ref={contentRef} className="mx-auto w-full max-w-3xl px-6 py-4 max-[1100px]:px-4">
          {rows.length === 0 ? (
            <p className="text-ui text-muted-foreground">{empty}</p>
          ) : (
            <ol className="grid gap-3">
              {rows.map((row) => (
                <li key={row.id} className="min-w-0">
                  <RowView row={row} threads={threads} />
                </li>
              ))}
            </ol>
          )}
          {live !== undefined && live !== null && (
            <p className="mt-3 flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
              <span
                className="size-2 shrink-0 rounded-full bg-info motion-safe:animate-pulse"
                aria-hidden
              />
              <span className="min-w-0 truncate font-mono">
                {live || <span className="sr-only">Running</span>}
              </span>
            </p>
          )}
        </div>
      </div>
      <div
        className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center transition-[opacity,translate] duration-200 data-[hidden=true]:translate-y-full data-[hidden=true]:opacity-0"
        data-hidden={mode === "follow"}
        // `inert` takes the faded pill out of clicks, focus and the accessibility tree.
        inert={mode === "follow"}
      >
        <button
          type="button"
          onClick={enterFollow}
          className="pointer-events-auto grid size-8 place-items-center rounded-full border border-border bg-card text-foreground shadow-md hover:bg-accent"
        >
          <ArrowDown className="size-4" aria-hidden />
          <span className="sr-only">Scroll to latest</span>
        </button>
      </div>
    </div>
  );
}

function RowView({ row, threads }: { row: Row; threads: Map<string, Thread> }) {
  switch (row.kind) {
    case "prose":
      return (
        <div className="group relative">
          <StreamingText text={row.text} streaming={row.streaming} />
          {row.usage && (
            <div className="absolute top-0 -left-8 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-[1100px]:hidden">
              <InfoButton
                label="Usage"
                sections={[{ title: "This reply", rows: usageRows(row.usage) }]}
              />
            </div>
          )}
        </div>
      );
    case "process":
      return (
        <ProcessDisclosure label={row.digest}>
          <div className="space-y-1">
            {row.steps.map((s) => (
              <StepView key={s.id} step={s} />
            ))}
          </div>
        </ProcessDisclosure>
      );
    case "brief":
      return (
        <ProcessDisclosure label={row.label}>
          <Markdown text={row.text} className="rounded-lg bg-muted px-3 py-2 text-ui" />
        </ProcessDisclosure>
      );
    case "checkpoint":
      return <Checkpoint event={row.event} />;
    case "output":
      return <OutputRow event={row.event} />;
    case "failure":
      return (
        <p
          role="alert"
          className="rounded-xl bg-destructive-tint px-3 py-2 text-ui text-destructive"
        >
          {row.text}
        </p>
      );
    case "wake":
      return <WakeTurn event={row.event} partial={row.partial} />;
    case "agent": {
      const thread = threads.get(row.threadId);
      return thread ? <AgentCard thread={thread} /> : null;
    }
  }
}

const TOOL_ICON: Record<string, LucideIcon> = {
  bash: Terminal,
  view_image: Image,
  checklist: ListChecks,
  checkpoint: Flag,
  report_output: PackageCheck,
  thread_message: MessageSquare,
  segment_sam: Wand,
};

function StepView({ step }: { step: Step }) {
  switch (step.kind) {
    case "reasoning":
      return (
        <ActivityRow Icon={Brain} quietIcon proseClassName="italic text-fg-subtle">
          <Markdown text={step.text} />
        </ActivityRow>
      );
    case "note":
      return <ActivityRow Icon={Cog} title={step.text} status={step.failed ? "error" : "done"} />;
    case "tool":
      return (
        <ActivityRow
          Icon={(step.name && TOOL_ICON[step.name]) || Terminal}
          title={
            <span className={step.name === "bash" || !step.name ? "font-mono text-meta" : ""}>
              {step.title}
            </span>
          }
          status={step.status}
          expand={() => <ToolBody step={step} />}
        />
      );
  }
}

function ToolBody({ step }: { step: ToolStep }) {
  const command = (step.input as { command?: unknown } | undefined)?.command;
  const input =
    step.args ??
    (step.name === "bash" && typeof command === "string"
      ? command
      : JSON.stringify(step.input, null, 2));
  return (
    <div className="grid gap-1.5">
      <Pre>{input}</Pre>
      {step.output !== undefined && (
        <Pre tone={step.status === "error" ? "error" : undefined}>
          {step.output || "(no output)"}
        </Pre>
      )}
      {step.truncated && (
        <p className="text-meta text-muted-foreground">
          Shortened: part of the output is not shown.
        </p>
      )}
    </div>
  );
}

function Pre({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <pre
      className={`max-h-72 overflow-auto rounded-md px-3 py-2 font-mono text-meta whitespace-pre-wrap break-words ${
        tone === "error" ? "bg-destructive-tint text-destructive" : "bg-muted text-foreground"
      }`}
    >
      {children}
    </pre>
  );
}

function Checkpoint({ event }: { event: Extract<RunEvent, { type: "checkpoint" }> }) {
  const { verdict, toCheck, text, evidence } = event.payload;
  const body = (
    <div className="flex min-w-0 items-start gap-2">
      <Flag className="mt-1 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
      <div className="min-w-0 flex-1">
        {(verdict || toCheck) && (
          <div className="mb-1 flex flex-wrap items-center gap-2">
            {verdict && (
              <StatusBadge tone={verdict === "passed" ? "primary" : "check"}>
                {verdict === "passed" ? "Check passed" : "Needs review"}
              </StatusBadge>
            )}
            {toCheck && <StatusBadge tone="check">To check: {toCheck.title}</StatusBadge>}
          </div>
        )}
        <Markdown text={text} className="text-ui" />
        {evidence.length > 0 && (
          <p
            className="mt-1 truncate font-mono text-meta text-fg-subtle"
            title={evidence.map((r) => r.path).join("\n")}
          >
            {evidence.map((r) => r.path.split("/").pop()).join(", ")}
          </p>
        )}
      </div>
    </div>
  );
  return toCheck || verdict === "needs-review" ? (
    <div className="rounded-xl border border-check-line bg-check-tint px-3 py-2 text-check-strong">
      {body}
    </div>
  ) : (
    body
  );
}

function outputValue(o: Extract<RunEvent, { type: "output" }>["payload"]["output"]): string | null {
  switch (o.kind) {
    case "measurement":
      return `${o.value} ${o.unit}`;
    case "score":
      return String(o.level);
    case "structure":
      return o.volumeMm3 !== undefined ? `${o.volumeMm3} mm³` : null;
    default:
      return null;
  }
}

function OutputRow({ event }: { event: Extract<RunEvent, { type: "output" }> }) {
  const value = outputValue(event.payload.output);
  return (
    <p className="flex min-w-0 items-center gap-2 text-ui">
      <PackageCheck className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 truncate">
        Reported <span className="font-medium">{event.payload.title}</span>
      </span>
      {value && <span className="shrink-0 font-mono text-meta tabular-nums">{value}</span>}
    </p>
  );
}

const POINTS: Record<Wake["payload"]["point"]["kind"], (task: string) => string> = {
  "run-started": () => "read the plan before the run started",
  "task-checked": (t) => `woke after the ${t} check`,
  "check-disagreed": (t) => `woke because the checker disagreed on ${t}`,
  "thread-failed": (t) => `woke because the ${t} worker failed`,
};

const DECISION = {
  accept: { label: "Accepted", tone: "primary" },
  redo: { label: "Redo", tone: "info" },
  fail: { label: "Failed the task", tone: "destructive" },
} as const;

function MainMark() {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary-tint text-primary-strong">
      <Workflow className="size-3.5" aria-hidden />
    </span>
  );
}

/** A turn of the main thread: who and why it woke, what it decided, then its notes, clamped. */
function WakeTurn({ event, partial }: { event?: Wake; partial?: string }) {
  if (!event)
    return (
      <div>
        <p className="mb-1 flex items-center gap-2 text-ui">
          <MainMark />
          <span className="font-medium">Main thread</span>
          <span className="text-muted-foreground">is writing</span>
        </p>
        <div className="pl-8">
          <StreamingText text={partial ?? ""} streaming />
        </div>
      </div>
    );
  const { point, note, decision, error, plan, usage, model } = event.payload;
  const verdict = decision && DECISION[decision.action];
  return (
    <div>
      <div className="flex min-w-0 items-center gap-2 text-ui">
        <MainMark />
        <span className="shrink-0 font-medium">Main thread</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {POINTS[point.kind]("taskId" in point ? taskTitle(point.taskId) : "")}
        </span>
        {verdict && <StatusBadge tone={verdict.tone}>{verdict.label}</StatusBadge>}
        <span className="ml-auto" />
        {usage && (
          <InfoButton
            label="Usage"
            sections={[{ title: "This wake", rows: usageRows(usage, model) }]}
          />
        )}
      </div>
      <div className="mt-1 grid gap-1.5 pl-8">
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-destructive-tint px-3 py-2 text-ui text-destructive"
          >
            It did not answer: {error}
          </p>
        )}
        {decision && <p className="text-sm">{decision.reason}</p>}
        {plan && <p className="text-sm">It changed the plan.</p>}
        {note && <ClampedMarkdown text={note} label="Notes for later threads" />}
      </div>
    </div>
  );
}
