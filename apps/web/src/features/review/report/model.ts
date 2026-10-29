/**
 * The review's data is the shared contract (`@voluma/contracts/review`), loaded by
 * `getReviewRun`. Display helpers leave scientific task status unchanged.
 */
import type { TaskStatus } from "@voluma/contracts/ids";
import type { ReviewTask, Revision } from "@voluma/contracts/review";
import type { StatusTone } from "@voluma/ui";

export type {
  Asset,
  Measurement,
  ReviewRun,
  ReviewTask,
  Revision,
  Score,
} from "@voluma/contracts/review";

const statuses: Record<TaskStatus, { label: string; tone: StatusTone }> = {
  pending: { label: "Not started", tone: "neutral" },
  stale: { label: "Queued", tone: "neutral" },
  "in-progress": { label: "Running", tone: "info" },
  done: { label: "Done", tone: "primary" },
  failed: { label: "Failed", tone: "destructive" },
  "to-check": { label: "To check", tone: "check" },
  "under-review": { label: "Checking", tone: "info" },
};

/** A pending row has no attempt; a recorded worker start still rules out "Not started". */
export function taskStatus(task: ReviewTask): { label: string; tone: StatusTone } {
  return task.status === "pending" && task.threads.worker
    ? { label: "No result recorded", tone: "neutral" }
    : statuses[task.status];
}

/** The structures a task reported, and those its numbers are shown with. */
export function structuresOf(revision: Revision, task: ReviewTask) {
  const shownWith = new Set(
    [...task.measurements, ...task.scores].flatMap((m) => [...m.on, ...m.context]),
  );
  return revision.structures.filter(
    (item) => item.id.startsWith(`${task.id}/`) || shownWith.has(item.id),
  );
}
