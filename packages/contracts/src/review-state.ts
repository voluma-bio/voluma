/** Human review overlays scientific results; it never changes the scientific fold. */
import type { RunEvent } from "./events";
import { fold } from "./fold";
import type { ReviewSummary } from "./review";

export function reviewState(events: readonly RunEvent[]) {
  const folded = fold(events);
  const accepted = new Set<string>();
  const key = (task: string, result: string, check: string) =>
    JSON.stringify([task, result, check]);
  let cursor = 0;
  const revisions = folded.revisions.map((revision, index) => {
    const next = folded.revisions[index + 1]?.id;
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
        remainingToCheck: latest.tasks.reduce(
          (n, task) => n + task.checks.filter((check) => check.status === "open").length,
          0,
        ),
        reviewedAt: completed?.createdAt ?? null,
      }
    : null;
  return { revisions, summary, assets: folded.assets };
}
