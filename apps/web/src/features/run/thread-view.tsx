/** One thread's full transcript: model messages, tool calls with arguments and results, and the thread's other events, in order. */
import type { RunEvent } from "@voluma/contracts/events";
import { StatusBadge } from "@voluma/ui";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { WakeCard } from "./feed";
import { Follow } from "./follow";
import { Clamp, clock, threadName } from "./parts";
import { type Thread, type ThreadItem, threadItemsOf, toolSummary, usageLine } from "./run-feed";
import { taskTitle } from "./workflows";

export function ThreadView({
  events,
  thread,
  closeTo,
}: {
  events: RunEvent[];
  thread: Thread;
  closeTo: string;
}) {
  const items = useMemo(() => threadItemsOf(events, thread.id), [events, thread.id]);
  // `n` changes on each click so every tool row re-reads `value`.
  const [all, setAll] = useState<{ value: boolean; n: number }>({ value: false, n: 0 });
  return (
    <aside className="flex min-h-0 flex-col rounded-xl border border-border bg-card max-[1100px]:min-h-[60dvh]">
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{threadName(thread)}</h2>
          <p className="text-meta text-muted-foreground">
            {thread.model && <span className="font-mono">{thread.model}, </span>}
            {thread.status === "running" ? "working now" : thread.status}
            {thread.toolCalls > 0 && `, ${thread.toolCalls} tool calls`}
            {thread.usage && `, ${usageLine(thread.usage)}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAll({ value: !all.value, n: all.n + 1 })}
          className="rounded-md px-2 py-1 text-meta text-primary-text hover:bg-accent"
        >
          {all.value ? "Collapse all" : "Expand all"}
        </button>
        <Link
          to={closeTo}
          aria-label="Close thread"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent"
        >
          <X size={18} aria-hidden="true" />
        </Link>
      </header>
      <Follow changes={items} resetKey={thread.id} className="px-4 py-3">
        {items.length === 0 ? (
          <p className="text-ui text-muted-foreground">Nothing has happened in this thread yet.</p>
        ) : (
          <ol className="grid gap-3">
            {items.map((item) => (
              <li key={item.id} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
                <time
                  dateTime={item.at}
                  className="pt-0.5 text-meta whitespace-nowrap text-fg-subtle tabular-nums"
                >
                  {clock(item.at)}
                </time>
                <Item item={item} all={all} />
              </li>
            ))}
          </ol>
        )}
      </Follow>
    </aside>
  );
}

function Item({ item, all }: { item: ThreadItem; all: { value: boolean; n: number } }) {
  switch (item.kind) {
    case "message":
      return item.role === "assistant" ? (
        <div>
          {item.text && <p className="whitespace-pre-wrap text-ui">{item.text}</p>}
          {item.usage && (
            <p className="text-meta text-fg-subtle tabular-nums">
              {item.usage.cacheRead === 0 && "Cold, "}
              {usageLine(item.usage)}
            </p>
          )}
        </div>
      ) : (
        <details>
          <summary className="cursor-pointer text-meta text-muted-foreground">
            {item.role === "system" ? "System prompt" : "Message to the model"}
          </summary>
          <div className="mt-1">
            <Clamp text={item.text} />
          </div>
        </details>
      );
    case "tool":
      return <ToolRow item={item} all={all} />;
    case "event":
      return <EventRow event={item.event} />;
  }
}

function ToolRow({
  item,
  all,
}: {
  item: Extract<ThreadItem, { kind: "tool" }>;
  all: { value: boolean; n: number };
}) {
  const { result } = item;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (all.n > 0) setOpen(all.value);
  }, [all.n]);
  const input =
    item.name === "bash" && typeof (item.input as { command?: unknown })?.command === "string"
      ? (item.input as { command: string }).command
      : JSON.stringify(item.input, null, 2);
  return (
    <details
      open={open || result?.isError}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="rounded-md border border-border"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-meta">
        <span className="font-mono font-medium">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
          {toolSummary(item.name, item.input)}
        </span>
        {!result && <StatusBadge tone="info">Running</StatusBadge>}
        {result?.isError && <StatusBadge tone="destructive">Failed</StatusBadge>}
      </summary>
      <div className="grid gap-2 border-t border-border p-3">
        <Clamp text={input} mono />
        {result && (
          <>
            <Clamp
              text={result.output || "(no output)"}
              mono
              tone={result.isError ? "error" : undefined}
            />
            {result.truncated && (
              <p className="text-meta text-muted-foreground">
                The runner shortened this output to its start and end.
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function EventRow({ event: e }: { event: RunEvent }) {
  switch (e.type) {
    case "wake":
      return <WakeCard event={e} />;
    case "checkpoint":
      return (
        <div className="rounded-md bg-muted px-3 py-2 text-ui">
          <p className="text-meta font-medium">
            {e.payload.verdict ? `Verdict: ${e.payload.verdict}` : "Checkpoint"}
            {e.payload.toCheck && ` (to check: ${e.payload.toCheck.title})`}
          </p>
          <p className="whitespace-pre-wrap">{e.payload.text}</p>
          {e.payload.evidence.length > 0 && (
            <p className="mt-1 font-mono text-meta text-muted-foreground">
              {e.payload.evidence.map((r) => r.path).join(", ")}
            </p>
          )}
        </div>
      );
    case "output":
      return (
        <p className="rounded-md bg-primary-tint px-3 py-2 text-ui text-primary-strong">
          Reported output <span className="font-mono">{e.payload.outputId}</span>: {e.payload.title}
        </p>
      );
    case "task":
      return (
        <p className="text-meta text-muted-foreground">
          {taskTitle(e.payload.taskId)} is {e.payload.status}
          {e.payload.by.kind === "agent" ? "" : ` (set by the supervisor, ${e.payload.by.kind})`}.{" "}
          {e.payload.reason}
        </p>
      );
    case "sandbox":
      return (
        <p className="text-meta text-muted-foreground">
          Sandbox {e.payload.name} {e.payload.state}
          {e.payload.detail && `: ${e.payload.detail}`}
        </p>
      );
    case "attempt.opened":
      return (
        <p className="text-meta text-muted-foreground">
          Attempt opened on {taskTitle(e.payload.taskId)}.
        </p>
      );
    case "revision.started":
      return (
        <p className="text-meta text-muted-foreground">Revision started ({e.payload.reason}).</p>
      );
    case "judgment":
      return (
        <p className="text-meta text-muted-foreground">
          Judgment ({e.payload.arm}): applied {e.payload.applied.action}.
        </p>
      );
    case "thread.started":
      return <p className="text-meta text-muted-foreground">Thread started.</p>;
    case "thread.ended":
      return (
        <p
          className={`text-meta ${e.payload.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
        >
          Thread {e.payload.status}.{e.payload.error && ` ${e.payload.error}`}
        </p>
      );
    default:
      return null;
  }
}
