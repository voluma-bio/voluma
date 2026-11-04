/**
 * The status words of a run and of a study, from their read models alone (no events), shared by
 * Studies, the study page and the input review so they read the same: Running, N to check, Checked,
 * Failed, Stopped, Waiting (queued), Needs your keys, Waiting on you, Not started. A completed run
 * with no open item reads "Checked". Also where a run's row links (the input review), how an input
 * is named, and how its cost, time and age ("12 min ago") read.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { Run, RunState } from "@voluma/contracts/run";
import type { StudyMember, StudyRunSummary } from "@voluma/contracts/study";
import type { Status } from "@voluma/ui";

/** "1 run", "3 runs"; `many` for an irregular plural. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * US dollars: cents; a tenth of a cent under a dollar, so a short run doesn't read $0.00; a
 * hundredth of a cent under a cent, so one cached reply doesn't read $0.000. None is $0.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`;
}

/**
 * What a run has spent, in US dollars: the runner's own model calls (heartbeats) plus the
 * sandboxes' provider calls through the gateway, two separate amounts. A request of unknown cost
 * adds nothing (`providerCalls.unknownCostCalls`), so this is a floor while there are any.
 */
export const runCost = (run: Pick<Run, "usage" | "providerCalls">) =>
  run.usage.modelCostUsd + run.providerCalls.costUsd;

/**
 * The spans a run worked: its first claim to its end, then each correction from its
 * `run.reopened` to the root thread's next end or its `correction.ended`. The time between an
 * end and a researcher's reopen is not work. The last span runs to the run's end, or to `now`
 * while the run goes. A run queued again after a reopen or a lost runner has no `startedAt` in its
 * state, so the first claim comes from the log. `reopens` counts every message that reopened it.
 */
export function runWork(
  events: readonly RunEvent[],
  state: RunState,
  now: number,
): { startedAt: string; seconds: number; reopens: number } | undefined {
  const startedAt =
    (state.status === "queued" ? null : state.startedAt) ??
    events.find((e) => e.type === "claim.started")?.createdAt;
  if (!startedAt) return undefined;
  const roots = new Set<string>();
  const starts = [Date.parse(startedAt)];
  const ends: (number | undefined)[] = [];
  for (const e of events) {
    if (e.type === "thread.started" && e.payload.parentThreadId === null) roots.add(e.threadId);
    else if (e.type === "run.reopened") starts.push(Date.parse(e.createdAt));
    else if ((e.type === "thread.ended" && roots.has(e.threadId)) || e.type === "correction.ended")
      // The latest end inside a span closes it: a resumed root can end more than once.
      ends[starts.length - 1] = Date.parse(e.createdAt);
  }
  const last = state.status === "ended" ? Date.parse(state.endedAt) : now;
  let seconds = 0;
  starts.forEach((start, i) => {
    const end =
      i === starts.length - 1 && state.status !== "ended"
        ? last
        : (ends[i] ?? starts[i + 1] ?? last);
    seconds += Math.max(0, end - start) / 1000;
  });
  return { startedAt, seconds, reopens: starts.length - 1 };
}

/** Whole seconds as `45 s`, `12 min 5 s` or `2 h 3 min`. */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** An input as people name it: its subject and knee ("OA6-1, right knee"), the subject alone without one. */
export function inputLabel(input: Pick<StudyMember, "subject" | "attributes">): string {
  const knee = input.attributes.knee;
  return typeof knee === "string" && knee
    ? `${input.subject}, ${knee.toLowerCase()} knee`
    : input.subject;
}

/**
 * Where an input opens: its page in a study, on the input's newest run (live while it goes, for
 * review once it ends). `query` carries the page's selection (`output`, `item`...); a link
 * that means an earlier run adds `run`.
 */
export const inputHref = (studyId: string, inputId: string, query: Record<string, string> = {}) =>
  `/studies/${encodeURIComponent(studyId)}/inputs/${encodeURIComponent(inputId)}${
    Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : ""
  }`;

export type RunStatus = { label: string; status: Status };

/** A run as a status reads it: a study's newest-run summary, or a run with its input's review. */
type StatusFacts = Pick<StudyRunSummary, "state" | "outputs" | "waiting"> & {
  /** The run's review in brief: its open To check items once it completed; null before. */
  review: { needsYou: number } | null;
};

/**
 * A run's status, with "Running · N of M in" (its final outputs) while it runs: what a row says
 * about a live run.
 */
export function liveStatus(run: StatusFacts): RunStatus {
  if (run.waiting) return WAITING_ON_YOU;
  if (run.state.status === "running" && run.outputs)
    return {
      label: `Running · ${run.outputs.done} of ${run.outputs.total} in`,
      status: "running",
    };
  return runStatus(run);
}

/** What needs a person on one run: its open To check items, never samples ("3 to check"). */
export const toCheckText = (n: number) => `${n} to check`;

/** A run with a held call the researcher can answer (`StudyRunSummary.waiting`): whatever its row says. */
const WAITING_ON_YOU: RunStatus = { label: "Waiting on you", status: "check" };

/** A run's status from its state and its review in brief. */
export function runStatus({ state, review }: Pick<StatusFacts, "state" | "review">): RunStatus {
  switch (state.status) {
    case "queued":
      return { label: "Waiting", status: "waiting" };
    case "running":
      return { label: "Running", status: "running" };
    case "awaiting-keys":
      return { label: "Needs your keys", status: "paused" };
    case "ended":
      if (state.outcome === "completed")
        return review?.needsYou
          ? { label: toCheckText(review.needsYou), status: "check" }
          : { label: "Checked", status: "done" };
      if (state.outcome === "failed") return { label: "Failed", status: "stopped" };
      return { label: "Stopped", status: "stopped" };
  }
}

const MINUTE = 60_000;

/** "just now", "4 min ago", "3 h ago", "yesterday", "31 Oct" (with the year when not this one). */
export function whenText(iso: string, now: number): string {
  const then = new Date(iso);
  const ago = now - then.getTime();
  if (ago < MINUTE) return "just now";
  if (ago < 60 * MINUTE) return `${Math.floor(ago / MINUTE)} min ago`;
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(then, today)) return `${Math.floor(ago / (60 * MINUTE))} h ago`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(then, yesterday)) return "yesterday";
  return then.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(then.getFullYear() !== today.getFullYear() && { year: "numeric" }),
  });
}
