/**
 * A reopened run's corrections, each as its own span on the run page: what the researcher asked,
 * the task it redid, how long it took and what it cost. The spans are `corrections`
 * (`@voluma/contracts/fold`), the one reader of correction state; this adds what the page shows.
 */

import type { RunEvent } from "@voluma/contracts/events";
import { corrections } from "@voluma/contracts/fold";
import { spend } from "@voluma/contracts/spend";
import { formatDuration, formatUsd } from "@voluma/ui/run";
import { Link } from "react-router";
import { Section } from "./overview";

export type CorrectionView = {
  id: string;
  /** How long it took, in seconds; absent while it runs. */
  tookSeconds?: number;
  /** The researcher's message; a go reads "Go ahead". */
  asked?: { text: string; go: boolean };
  /** The task a go redid. */
  redid?: string;
  outcome: "running" | "done" | "failed" | "cancelled";
  error?: string;
  costUsd: number;
};

/** `live`: the run is queued or running, so its open span is still being worked on. */
export function correctionViews(events: readonly RunEvent[], live: boolean): CorrectionView[] {
  // The root thread's id changes when the lead AI starts again as a new thread.
  const roots = new Set(
    events.flatMap((e) =>
      e.type === "thread.started" && e.payload.kind === "supervisor" ? [e.threadId] : [],
    ),
  );
  return corrections(events).spans.map((span) => {
    const stop = span.closed === "abandoned" ? events[span.to] : undefined;
    // The span with its end, when a `correction.ended` closed it.
    const slice = events.slice(span.reopened, stop ? span.to + 1 : span.to);
    const said = slice.find((e) => e.type === "person.message");
    const running = span.closed === "open" && live;
    const end =
      stop ?? [...slice].reverse().find((e) => e.type === "thread.ended" && roots.has(e.threadId));
    const start = Date.parse(events[span.reopened]!.createdAt);
    return {
      id: span.reopenId,
      ...(!running && end && { tookSeconds: (Date.parse(end.createdAt) - start) / 1000 }),
      ...(said?.type === "person.message" && {
        asked: {
          text: said.payload.go ? "Go ahead" : (said.payload.text ?? ""),
          go: !!said.payload.go,
        },
      }),
      ...(span.go && { redid: span.go.taskId }),
      outcome:
        stop?.type === "correction.ended" ? stop.payload.status : running ? "running" : "done",
      ...(stop?.type === "correction.ended" && stop.payload.error && { error: stop.payload.error }),
      // Each usage counts in the total whatever its thread, so a span's slice is its cost.
      costUsd: spend(slice).total.costUsd,
    };
  });
}

/** A message queued the run again and no runner has started on it yet. */
export function reopenUnclaimed(events: readonly RunEvent[]): boolean {
  const { open } = corrections(events);
  return (
    open !== undefined && !events.slice(open.reopened).some((e) => e.type === "thread.started")
  );
}

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
              {c.tookSeconds !== undefined && (
                <span className="text-muted-foreground">took {formatDuration(c.tookSeconds)}</span>
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
