/**
 * A reopened run's corrections, each as its own span on the run page: when it started, what the
 * researcher asked, the task it redid, how long it took and what it cost. The spans are
 * `corrections` (`@voluma/contracts/fold`), the one reader of correction state; this adds what
 * the page shows. Cost is the spend of the log up to the span's end less the spend up to its
 * start (`spend` is prefix-additive).
 */

import type { RunEvent } from "@voluma/contracts/events";
import { corrections } from "@voluma/contracts/fold";
import { spend } from "@voluma/contracts/spend";
import { formatDuration, formatUsd } from "@voluma/ui/run";
import { Link } from "react-router";
import { Section } from "./overview";

export type CorrectionView = {
  id: string;
  startedAt: string;
  /** Absent while it runs. */
  endedAt?: string;
  /** The researcher's message; a go reads "Go ahead". */
  asked?: { text: string; go: boolean };
  /** The task a go redid. */
  redid?: string;
  /** The AI's answers in this span. */
  replies: string[];
  outcome: "running" | "done" | "failed" | "cancelled";
  error?: string;
  costUsd: number;
};

/** `live`: the run is queued or running, so its open span is still being worked on. */
export function correctionViews(events: readonly RunEvent[], live: boolean): CorrectionView[] {
  const cost = (to: number) => spend(events.slice(0, to)).total.costUsd;
  const root = events.find((e) => e.type === "thread.started" && e.payload.kind === "supervisor");
  return corrections(events).spans.map((span) => {
    const slice = events.slice(span.reopened, span.to);
    const said = slice.find((e) => e.type === "person.message");
    const stop = span.closed === "abandoned" ? events[span.to] : undefined;
    const running = span.closed === "open" && live;
    const rootEnd = [...slice]
      .reverse()
      .find((e) => e.type === "thread.ended" && e.threadId === root?.threadId);
    const endAt = stop ? span.to + 1 : span.to;
    return {
      id: span.reopenId,
      startedAt: events[span.reopened]!.createdAt,
      ...(!running && { endedAt: (stop ?? rootEnd)?.createdAt }),
      ...(said?.type === "person.message" && {
        asked: {
          text: said.payload.go ? "Go ahead" : (said.payload.text ?? ""),
          go: !!said.payload.go,
        },
      }),
      ...(span.go && { redid: span.go.taskId }),
      replies: slice.flatMap((e) => (e.type === "reply" ? [e.payload.text] : [])),
      outcome:
        stop?.type === "correction.ended" ? stop.payload.status : running ? "running" : "done",
      ...(stop?.type === "correction.ended" && stop.payload.error && { error: stop.payload.error }),
      costUsd: cost(endAt) - cost(span.reopened),
    };
  });
}

/** The AI answered the latest note, nothing runs, and no go followed: the next move is the researcher's. */
export const waitingOnYou = (spans: readonly CorrectionView[]) => {
  const last = spans.at(-1);
  return last?.outcome === "done" && last.redid === undefined && last.replies.length > 0;
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
  spans: CorrectionView[];
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
            {c.asked && (
              <p className={c.asked.go ? "font-medium" : "whitespace-pre-wrap"}>{c.asked.text}</p>
            )}
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

function outcomeWord(c: CorrectionView, titleOf: (taskId: string) => string) {
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
