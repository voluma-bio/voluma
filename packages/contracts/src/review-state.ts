/** Human review overlays scientific results; it never changes the scientific fold. */
import type { RunEvent } from "./events";
import { fold } from "./fold";
import type { TaskStatus } from "./ids";
import type { ReviewSummary } from "./review";

/**
 * The revisions a correction that ended unfinished (`correction.ended`: failed, cancelled, or
 * stalled) opened, from the latest `run.reopened` before it. They are not the run's result:
 * the revision before them stays the current one (`messages.ts`).
 */
function abandonedRevisions(events: readonly RunEvent[]): Set<string> {
  const abandoned = new Set<string>();
  let opened: string[] = [];
  for (const event of events) {
    if (event.type === "run.reopened") opened = [];
    else if (event.type === "revision.started") opened.push(event.id);
    else if (event.type === "correction.ended") {
      for (const id of opened) abandoned.add(id);
      opened = [];
    }
  }
  return abandoned;
}

export function reviewState(events: readonly RunEvent[]) {
  const folded = fold(events);
  const abandoned = abandonedRevisions(events);
  const kept = folded.revisions.filter((revision) => !abandoned.has(revision.id));
  const accepted = new Set<string>();
  const key = (task: string, result: string, check: string) =>
    JSON.stringify([task, result, check]);
  let cursor = 0;
  const revisions = kept.map((revision, index) => {
    const next = kept[index + 1]?.id;
    while (events[cursor] && events[cursor]?.id !== next) {
      const event = events[cursor++];
      if (event?.type === "check.accepted") {
        const p = event.payload;
        accepted.add(key(p.taskId, p.resultRevisionId, p.checkId));
      }
    }
    return {
      ...revision,
      tasks: revision.tasks.map((task) => ({
        ...task,
        checks: task.checks.map((check) => ({
          ...check,
          status: accepted.has(key(task.id, task.resultRevisionId, check.id))
            ? ("accepted" as const)
            : check.status,
        })),
      })),
    };
  });
  const latest = revisions.at(-1);
  const completed = events.find(
    (event) => event.type === "review.completed" && event.payload.revisionId === latest?.id,
  );
  const summary: ReviewSummary | null = latest
    ? {
        revisionId: latest.id,
        remainingToCheck: progress(latest).toCheck,
        reviewedAt: completed?.createdAt ?? null,
      }
    : null;
  return { revisions, summary, assets: folded.assets };
}

/**
 * How far a revision got, as Home, the study and the run page all count it: tasks done of the
 * plan's (To check counts, a skipped task among them: its work is over), and the open check
 * items, the ones a person can accept.
 */
export function progress(revision: {
  tasks: readonly { status: TaskStatus; checks: readonly { status: string }[] }[];
  plan: { tasks: readonly unknown[] };
}): { done: number; total: number; toCheck: number } {
  return {
    done: revision.tasks.filter((t) => t.status === "done" || t.status === "to-check").length,
    total: revision.plan.tasks.length,
    toCheck: revision.tasks.reduce(
      (n, task) => n + task.checks.filter((check) => check.status === "open").length,
      0,
    ),
  };
}
