/**
 * Workers and checks as the lead AI's transcript shows them: an inline card where each started,
 * with its clock and cost (`spendRows` behind an info button). Anatomy from Meridian Flow's
 * `SpawnReportCard` and `SubagentRow` (apps/app/src/features/chat):
 * running, a card shows the live tool line and a ticking clock; finished, its result, and the row
 * expands to the report (built only on open). Rows expand, names navigate.
 */

import { cacheHitShare, type Spend } from "@voluma/contracts/spend";
import { STATUS_WORD, type Status, StatusMark } from "@voluma/ui";
import { Bot, ChevronDown, ShieldCheck } from "lucide-react";
import { useDisclosure } from "./chat/disclosure-store";
import { InfoButton, type InfoSection } from "./chat/info-button";
import { Markdown } from "./chat/markdown";
import { useOpenThread } from "./chat/thread-navigation";
import { agentTitle, isCheck, type Thread, workedSeconds } from "./run-model";
import { formatDuration, formatUsd } from "./run-status";
import { useThreads } from "./run-store";
import { useNow } from "./use-now";

const count = (n: number) => n.toLocaleString();

/** Cost, command time, then calls and tokens; a thread's wall time is its clock (`Elapsed`). */
function spendRows(s: Spend): InfoSection["rows"] {
  const hit = cacheHitShare(s);
  const rows: InfoSection["rows"] = [["Cost", formatUsd(s.costUsd)]];
  if (s.unknownCostCalls > 0)
    rows.push([
      "Cost unknown",
      `${count(s.unknownCostCalls)} gateway ${s.unknownCostCalls === 1 ? "request" : "requests"}`,
    ]);
  if (s.toolCostUsd > 0) rows.push(["Paid tools", formatUsd(s.toolCostUsd)]);
  // `bash` calls only: the runs list's sandbox time is the sandbox's uptime, which is longer.
  rows.push(["Command time", formatDuration(s.sandboxSeconds)]);
  rows.push(
    ["Model calls", count(s.calls)],
    ["Input tokens", count(s.input + s.cacheRead)],
    ["Output tokens", count(s.output)],
    ["Cache hit", hit === null ? "none" : `${Math.round(100 * hit)}%`],
    ["Cache writes", count(s.cacheWrite)],
  );
  return rows;
}

export function Elapsed({ thread }: { thread: Thread }) {
  const now = useNow(thread.status === "running");
  return (
    <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
      {formatDuration(workedSeconds(thread, now))}
    </span>
  );
}

/** A worker's or checker's own cost so far, once a model call reports one. */
function ThreadCost({ thread }: { thread: Thread }) {
  if (!thread.spend?.calls) return null;
  return (
    <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
      {formatUsd(thread.spend.costUsd)}
    </span>
  );
}

/** Its cost, command time, tokens and cache share behind an info button; its clock is `Elapsed`. */
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
  waiting: "bg-muted text-muted-foreground",
  paused: "bg-muted text-muted-foreground",
  completed: "bg-primary-tint text-primary-strong",
  failed: "bg-destructive-tint text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

export function AgentMark({ thread }: { thread: Thread }) {
  const Icon = isCheck(thread) ? ShieldCheck : Bot;
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
function AgentName({ thread, className = "" }: { thread: Thread; className?: string }) {
  const open = useOpenThread();
  const threads = useThreads();
  return (
    <button
      type="button"
      onClick={() => open(thread.id)}
      className={`relative z-10 min-w-0 truncate text-left font-medium text-foreground hover:text-primary-text hover:underline ${className}`}
    >
      {agentTitle(thread, threads)}
    </button>
  );
}

const VERDICT = {
  passed: { label: "Check passed", status: "done" },
  "needs-review": { label: "Needs review", status: "check" },
} as const;

function ResultLine({ thread }: { thread: Thread }) {
  if (thread.status === "running" || thread.status === "waiting" || thread.status === "paused")
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
      {verdict && <StatusMark status={verdict.status} label={verdict.label} />}
      <span className="min-w-0 truncate">{thread.result.text}</span>
    </p>
  );
}

/** A thread's status as the one status vocabulary of `@voluma/ui`. */
export const THREAD_STATUS: Record<Thread["status"], Status> = {
  running: "running",
  waiting: "waiting",
  paused: "paused",
  completed: "done",
  failed: "stopped",
  cancelled: "stopped",
};

/** A thread's status word: the mark's, except where the thread's state is more exact. */
export const threadWord = (status: Thread["status"]) =>
  status === "failed" ? "Failed" : STATUS_WORD[THREAD_STATUS[status]];

/** A worker's or checker's card in the main thread. */
export function AgentCard({ thread }: { thread: Thread }) {
  const [expanded, setExpanded] = useDisclosure(`card:${thread.id}`);
  const threads = useThreads();
  const running = thread.status === "running";
  const expandable = !running;
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5 shadow-xs">
      <div className="relative flex min-w-0 items-center gap-2">
        <AgentMark thread={thread} />
        <AgentName thread={thread} className="text-ui" />
        <span className="sr-only">{threadWord(thread.status)}</span>
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
              aria-label={`${expanded ? "Hide" : "Show"} the report of ${agentTitle(thread, threads)}`}
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
