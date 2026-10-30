/**
 * A reopened run's corrections, each as its own span on the run page: when it started, what the
 * researcher asked, the task it redid, how long it took and what it cost. A span runs from a
 * `run.reopened` to the root thread's next `thread.ended`, or to a `correction.ended` when the
 * correction failed or was stopped (the run keeps its earlier results). Cost is the spend of the
 * log up to the span's end less the spend up to its start (`spend` is prefix-additive).
 */

import type { RunEvent } from "@voluma/contracts/events";
import { spend } from "@voluma/contracts/spend";
import { formatDuration, formatUsd } from "@voluma/ui/run";
import { Link } from "react-router";
import { Section } from "./overview";

export type Correction = {
  id: string;
  startedAt: string;
  /** Absent while it runs. */
  endedAt?: string;
  /** The researcher's notes in this span, oldest first; a go is "Go ahead". */
  asked: { text: string; go: boolean }[];
  /** The task a go redid. */
  redid?: string;
  /** The AI's answers in this span. */
  replies: string[];
  outcome: "running" | "done" | "failed" | "cancelled";
  error?: string;
  costUsd: number;
};

export function corrections(events: readonly RunEvent[]): Correction[] {
  const spans: Correction[] = [];
  let root: string | undefined;
  let open: (Correction & { from: number }) | undefined;
  const cost = (to: number) => spend(events.slice(0, to)).total.costUsd;
  const close = (i: number, outcome: Correction["outcome"], error?: string) => {
    if (!open) return;
    const { from, ...span } = open;
    spans.push({
      ...span,
      endedAt: events[i]?.createdAt,
      outcome,
      ...(error && { error }),
      costUsd: cost(i + 1) - cost(from),
    });
    open = undefined;
  };
  events.forEach((e, i) => {
    if (e.type === "thread.started" && e.payload.kind === "supervisor") root ??= e.threadId;
    else if (e.type === "run.reopened")
      open = {
        id: e.id,
        from: i,
        startedAt: e.createdAt,
        asked: [],
        replies: [],
        outcome: "running",
        costUsd: 0,
      };
    else if (!open) return;
    else if (e.type === "person.message")
      open.asked.push({
        text: e.payload.go ? "Go ahead" : (e.payload.text ?? ""),
        go: !!e.payload.go,
      });
    else if (e.type === "reply") open.replies.push(e.payload.text);
    else if (e.type === "revision.started" && e.payload.reason === "correction")
      open.redid = e.payload.taskId;
    else if (e.type === "correction.ended") close(i, e.payload.status, e.payload.error);
    else if (e.type === "thread.ended" && e.threadId === root) close(i, "done");
  });
  if (open) {
    const { from, ...span } = open;
    spans.push({ ...span, costUsd: cost(events.length) - cost(from) });
  }
  return spans;
}

/** The AI answered the latest note, nothing runs, and no go followed: the next move is the researcher's. */
export const waitingOnYou = (spans: readonly Correction[]) => {
  const last = spans.at(-1);
  return (
    last?.outcome === "done" &&
    last.redid === undefined &&
    last.replies.length > 0 &&
    !last.asked.at(-1)?.go
  );
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

export function Corrections({
  spans,
  titleOf,
  search,
}: {
  spans: Correction[];
  titleOf: (taskId: string) => string;
  search: (taskId?: string) => string;
}) {
  return (
    <Section title="Corrections">
      <ol className="flex flex-col gap-3">
        {spans.map((c) => (
          <li
            key={c.id}
            className={`flex flex-col gap-2 rounded-xl border px-4 py-3 text-ui ${c.outcome === "running" ? "border-info bg-info-tint" : "border-border"}`}
          >
            <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <b className="font-semibold">{outcomeWord(c, titleOf)}</b>
              <span className="text-muted-foreground">{when(c.startedAt)}</span>
              {c.endedAt && (
                <span className="text-muted-foreground">
                  took {formatDuration((Date.parse(c.endedAt) - Date.parse(c.startedAt)) / 1000)}
                </span>
              )}
              <span className="font-mono text-muted-foreground tabular-nums">
                {formatUsd(c.costUsd)}
              </span>
            </p>
            <ul className="flex flex-col gap-1">
              {c.asked.map((a, i) => (
                <li key={i} className={a.go ? "font-medium" : "whitespace-pre-wrap"}>
                  {a.text}
                </li>
              ))}
            </ul>
            {c.redid && (
              <Link to={search(c.redid)} className="self-start text-primary-text hover:underline">
                Open {titleOf(c.redid)}
              </Link>
            )}
            {c.error && <p className="text-destructive">{c.error}</p>}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function outcomeWord(c: Correction, titleOf: (taskId: string) => string) {
  const task = c.redid ? titleOf(c.redid) : undefined;
  switch (c.outcome) {
    case "running":
      return task ? `Redoing ${task}` : "The AI is answering";
    case "done":
      return task ? `Redid ${task}` : "The AI answered";
    case "failed":
      return task ? `Redoing ${task} failed` : "The correction failed";
    case "cancelled":
      return "Stopped";
  }
}
