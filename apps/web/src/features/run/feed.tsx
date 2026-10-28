/**
 * The orchestration feed: the run as one chronological story. The main thread's wakes are its
 * own voice (tinted cards with its note and decision); the supervisor's mechanical steps are
 * quiet lines; worker and checker cards update live and open their thread beside the feed.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { WorkflowPlan } from "@voluma/contracts/workflow";
import { StatusBadge, type StatusTone } from "@voluma/ui";
import { Bot, ChevronRight, Cog } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Clamp, threadName } from "./parts";
import { type FeedEntry, type Thread, type ThreadStatus, usageLine } from "./run-feed";
import { taskTitle } from "./workflows";

type Wake = Extract<RunEvent, { type: "wake" }>;

export const threadHref = (id: string) => `?thread=${encodeURIComponent(id)}`;

export function Feed({
  entries,
  threads,
  openThread,
  hover,
  started,
}: {
  started: boolean;
  entries: FeedEntry[];
  threads: Map<string, Thread>;
  openThread: string | null;
  hover: string | null;
}) {
  return (
    <ol className="grid gap-3">
      {entries.map((entry) => {
        const thread = entry.kind === "thread" ? threads.get(entry.threadId) : undefined;
        const dim = hover !== null && entry.kind === "thread" && thread?.taskId !== hover;
        return (
          <li key={entry.id} className={`min-w-0 transition-opacity ${dim ? "opacity-40" : ""}`}>
            <Entry
              entry={entry}
              thread={thread}
              selected={thread?.id === openThread}
              started={started}
            />
          </li>
        );
      })}
    </ol>
  );
}

function Entry({
  entry,
  thread,
  selected,
  started,
}: {
  started: boolean;
  entry: FeedEntry;
  thread: Thread | undefined;
  selected: boolean;
}) {
  switch (entry.kind) {
    case "plan":
      return <PlanCard plan={entry.plan} started={started} />;
    case "wake":
      return <WakeCard event={entry.event} />;
    case "thread":
      return thread ? <ThreadCard thread={thread} selected={selected} /> : null;
    case "step":
      return (
        <p className="flex items-start gap-2 pt-2.5 text-meta text-muted-foreground">
          <Cog size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium">Supervisor</span> {entry.text}
          </span>
        </p>
      );
    case "verdict": {
      const passed = entry.event.payload.verdict === "passed";
      return (
        <section
          className={`rounded-xl border p-4 ${passed ? "border-border bg-card" : "border-check-line bg-check-tint"}`}
        >
          <div className="flex items-center gap-2">
            <StatusBadge tone={passed ? "primary" : "check"}>
              {passed ? "Check passed" : "Needs review"}
            </StatusBadge>
            <Link to={threadHref(entry.event.threadId)} className="font-medium hover:underline">
              {taskTitle(entry.event.payload.taskId)}
            </Link>
          </div>
          <p className="mt-2 text-ui">{entry.event.payload.text}</p>
        </section>
      );
    }
    case "to-check":
      return (
        <section className="rounded-xl border border-check-line bg-check-tint p-4 text-check-strong">
          <div className="flex items-center gap-2">
            <StatusBadge tone="check">To check</StatusBadge>
            <h3 className="font-medium">{entry.event.payload.toCheck?.title}</h3>
          </div>
          <p className="mt-2 text-ui">{entry.event.payload.text}</p>
        </section>
      );
    case "error":
      return (
        <Link
          to={threadHref(entry.threadId)}
          className="rounded-xl bg-destructive-tint p-3 text-ui text-destructive hover:underline"
        >
          {entry.text}
        </Link>
      );
  }
}

const POINTS: Record<Wake["payload"]["point"]["kind"], (task?: string) => string> = {
  "run-started": () => "Read the plan before the run started",
  "task-checked": (t) => `Woke after the check of ${t} passed`,
  "check-disagreed": (t) => `Woke because the checker disagreed on ${t}`,
  "thread-failed": (t) => `Woke because the worker for ${t} failed`,
};

export function WakeCard({ event }: { event: Wake }) {
  const { point, note, decision, error, model, plan } = event.payload;
  const task = "taskId" in point ? taskTitle(point.taskId) : undefined;
  return (
    <section className="rounded-xl border border-primary/30 bg-primary-tint p-4 text-primary-strong">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Bot size={16} aria-hidden="true" />
        <Link to={threadHref(event.threadId)} className="font-medium hover:underline">
          Main thread
        </Link>
        <span className="font-mono text-meta opacity-80">{model}</span>
        {event.payload.usage && (
          <span className="text-meta tabular-nums opacity-80">
            {usageLine(event.payload.usage)}
          </span>
        )}
      </div>
      <p className="mt-1 text-ui">{POINTS[point.kind](task)}</p>
      {error && <p className="mt-2 text-ui text-destructive">It did not answer: {error}</p>}
      {plan && <p className="mt-2 text-ui">It changed the plan.</p>}
      {note && (
        <div className="mt-2 text-foreground">
          <Clamp text={note} />
        </div>
      )}
      {decision && (
        <p className="mt-2 text-ui">
          <span className="font-medium capitalize">{decision.action}.</span> {decision.reason}
        </p>
      )}
    </section>
  );
}

const STATUS: Record<ThreadStatus, { label: string; tone: StatusTone }> = {
  running: { label: "Working", tone: "info" },
  completed: { label: "Finished", tone: "primary" },
  failed: { label: "Failed", tone: "destructive" },
  cancelled: { label: "Stopped", tone: "neutral" },
};

function ThreadCard({ thread, selected }: { thread: Thread; selected: boolean }) {
  const status = STATUS[thread.status];
  const live = thread.status === "running";
  const last = thread.recent.at(-1);
  return (
    <Link
      to={threadHref(thread.id)}
      aria-current={selected ? "true" : undefined}
      className={`block rounded-xl border bg-card hover:border-line-strong ${live ? "p-4" : "px-4 py-2.5"} ${
        selected ? "border-primary ring-1 ring-primary" : "border-border"
      }`}
    >
      <div className="flex items-center gap-x-3">
        <span className="shrink-0 font-medium">{threadName(thread)}</span>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        {!live && thread.result && (
          <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
            {thread.result}
          </span>
        )}
        <span className="ml-auto shrink-0 text-meta text-fg-subtle">
          {thread.toolCalls} {thread.toolCalls === 1 ? "call" : "calls"}
          {thread.toolErrors > 0 && `, ${thread.toolErrors} failed`}
        </span>
        <ChevronRight size={16} className="shrink-0 text-fg-subtle" aria-hidden="true" />
      </div>
      {live && last && (
        <p className="mt-2 truncate font-mono text-meta text-muted-foreground">{last.text}</p>
      )}
      {thread.error && <p className="mt-1 text-ui text-destructive">{thread.error}</p>}
    </Link>
  );
}

/** Open until the first thread starts, then one line; a click on the summary overrides either. */
function PlanCard({ plan, started }: { plan: WorkflowPlan; started: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !started;
  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        className="flex w-full items-center gap-2 text-left"
      >
        <ChevronRight
          size={14}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <span className="font-medium">The plan</span>
        <span className="text-meta text-muted-foreground">{plan.tasks.length} tasks</span>
      </button>
      {open && (
        <ol className="mt-2 grid gap-1 text-ui">
          {plan.tasks.map((t, i) => (
            <li key={t.id} className="flex gap-3">
              <span className="w-5 text-fg-subtle tabular-nums">{i + 1}</span>
              <span className="font-medium">{taskTitle(t.id)}</span>
              <span className="text-muted-foreground">
                {t.dependsOn.length > 0
                  ? `after ${t.dependsOn.map(taskTitle).join(", ")}`
                  : "starts first"}
                {`, ${t.outputs.length} ${t.outputs.length === 1 ? "output" : "outputs"}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
