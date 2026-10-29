/**
 * Workers and checkers as the main thread sees them: an inline card where each started, and a
 * strip of the ones running now above the transcript. Anatomy from Meridian Flow's
 * `SpawnReportCard`, `SubagentRow` and `RunningSubagentsStrip` (apps/app/src/features/chat):
 * running, a card shows the live tool line and a ticking clock; finished, its result, and the row
 * expands to the report (built only on open). Rows expand, names navigate.
 */
import { StatusBadge } from "@voluma/ui";
import { Bot, ChevronDown, ShieldCheck } from "lucide-react";
import { useDisclosure } from "./chat/disclosure-store";
import { InfoButton } from "./chat/info-button";
import { Markdown } from "./chat/markdown";
import { useOpenThread } from "./chat/thread-navigation";
import { type Thread, threadName } from "./run-model";
import { spendRows } from "./spend";
import { formatUsd, useNow } from "./status";

/** A duration as the reader says it: "45 s", "4 min 10 s", "2 h 5 min". */
function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function Elapsed({ thread }: { thread: Thread }) {
  const now = useNow(thread.status === "running");
  const end = thread.endedAt ? new Date(thread.endedAt).getTime() : now;
  return (
    <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
      {duration(end - new Date(thread.startedAt).getTime())}
    </span>
  );
}

/** A worker's or checker's own cost so far, once a model call reports one. */
export function ThreadCost({ thread }: { thread: Thread }) {
  if (!thread.spend?.calls) return null;
  return (
    <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
      {formatUsd(thread.spend.costUsd)}
    </span>
  );
}

/** Its cost, time, tokens and cache share behind an info button. */
export function ThreadSpendInfo({ thread }: { thread: Thread }) {
  if (!thread.spend?.calls) return null;
  return (
    <InfoButton
      label="Cost and usage"
      sections={[
        {
          title: thread.model ? `This thread, ${thread.model}` : "This thread",
          rows: spendRows(thread.spend),
        },
      ]}
    />
  );
}

const MARK: Record<Thread["status"], string> = {
  running: "bg-info-tint text-info",
  paused: "bg-muted text-muted-foreground",
  completed: "bg-primary-tint text-primary-strong",
  failed: "bg-destructive-tint text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

export function AgentMark({ thread }: { thread: Thread }) {
  const Icon = thread.kind === "check" ? ShieldCheck : Bot;
  return (
    <span
      className={`relative grid size-6 shrink-0 place-items-center rounded-full ${MARK[thread.status]}`}
    >
      <Icon className="size-3.5" aria-hidden />
      {thread.status === "running" && (
        <span
          className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-2 border-card bg-info motion-safe:animate-pulse"
          aria-hidden
        />
      )}
    </span>
  );
}

/** The door: a thread's name, which opens its transcript. */
export function AgentName({ thread, className = "" }: { thread: Thread; className?: string }) {
  const open = useOpenThread();
  return (
    <button
      type="button"
      onClick={() => open(thread.id)}
      className={`relative z-10 min-w-0 truncate text-left font-medium text-foreground hover:text-primary-text hover:underline ${className}`}
    >
      {threadName(thread)}
    </button>
  );
}

const VERDICT = {
  passed: { label: "Check passed", tone: "primary" },
  "needs-review": { label: "Needs review", tone: "check" },
} as const;

function ResultLine({ thread }: { thread: Thread }) {
  if (thread.status === "running" || thread.status === "paused")
    return (
      <p className="truncate font-mono text-meta text-muted-foreground">
        {thread.liveTool ?? thread.lastTool ?? "Starting"}
      </p>
    );
  if (thread.error) return <p className="text-meta text-destructive">{thread.error}</p>;
  if (!thread.result) return null;
  const verdict = thread.result.verdict && VERDICT[thread.result.verdict];
  return (
    <p className="flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
      {verdict && <StatusBadge tone={verdict.tone}>{verdict.label}</StatusBadge>}
      <span className="min-w-0 truncate">{thread.result.text}</span>
    </p>
  );
}

const STATUS_WORD: Record<Thread["status"], string> = {
  running: "Working",
  paused: "Paused",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
};

/** A worker's or checker's card in the main thread. */
export function AgentCard({ thread }: { thread: Thread }) {
  const [expanded, setExpanded] = useDisclosure(`card:${thread.id}`);
  const running = thread.status === "running";
  const expandable = !running;
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5 shadow-xs">
      <div className="relative flex min-w-0 items-center gap-2">
        <AgentMark thread={thread} />
        <AgentName thread={thread} className="text-ui" />
        <span className="sr-only">{STATUS_WORD[thread.status]}</span>
        <span className="ml-auto" />
        <ThreadCost thread={thread} />
        <Elapsed thread={thread} />
        {expandable && (
          <>
            <ChevronDown
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
              aria-hidden
            />
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide" : "Show"} the report of ${threadName(thread)}`}
              onClick={() => setExpanded(!expanded)}
              className="absolute -inset-1 rounded-md"
            />
          </>
        )}
      </div>
      <div className="mt-1 pl-8">
        <ResultLine thread={thread} />
      </div>
      {expanded && expandable && (
        <div className="mt-2 grid gap-2 border-t border-border pt-2 pl-8">
          {thread.said ? (
            <Markdown text={thread.said} className="text-ui" />
          ) : (
            <p className="text-meta text-muted-foreground">It wrote no report.</p>
          )}
          <div className="flex items-center gap-2 text-meta text-muted-foreground">
            <span>
              {thread.toolCalls} tool {thread.toolCalls === 1 ? "call" : "calls"}
              {thread.toolErrors > 0 && `, ${thread.toolErrors} failed`}
            </span>
            <ThreadSpendInfo thread={thread} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The workers and checkers running now, one line each, above the main thread. */
export function RunningStrip({ threads }: { threads: Thread[] }) {
  const [expanded, setExpanded] = useDisclosure("strip");
  if (threads.length === 0) return null;
  // Past three, the strip folds to a count like Flow's, so it never pushes the transcript away.
  const folded = threads.length > 3 && !expanded;
  return (
    <section aria-label="Running now" className="border-b border-border px-1 py-1.5">
      {threads.length > 3 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 py-0.5 text-ui font-medium text-muted-foreground hover:text-foreground"
        >
          <span className="size-1.5 rounded-full bg-info motion-safe:animate-pulse" aria-hidden />
          {threads.length} running
          <ChevronDown
            className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>
      )}
      {!folded && (
        <ul className="grid gap-0.5">
          {threads.map((t) => (
            <li key={t.id} className="flex min-w-0 items-center gap-2 py-0.5 text-ui">
              <AgentMark thread={t} />
              <AgentName thread={t} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground">
                {t.liveTool ?? t.lastTool ?? "Starting"}
              </span>
              <Elapsed thread={t} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
