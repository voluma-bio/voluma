/**
 * The review's data is the shared contract (`@voluma/contracts/review`), loaded by
 * `getReviewRun`. Display helpers leave scientific task status unchanged.
 */
import type { TaskStatus } from "@voluma/contracts/ids";
import type { ReviewTask, Revision } from "@voluma/contracts/review";
import type { Status } from "@voluma/ui";

export type {
  Asset,
  Measurement,
  ReviewRun,
  ReviewTask,
  Revision,
  Score,
} from "@voluma/contracts/review";

const statuses: Record<TaskStatus, { label: string; status: Status }> = {
  pending: { label: "Not started", status: "waiting" },
  stale: { label: "Queued", status: "waiting" },
  "in-progress": { label: "Running", status: "running" },
  done: { label: "Done", status: "done" },
  failed: { label: "Failed", status: "stopped" },
  "to-check": { label: "To check", status: "check" },
  "under-review": { label: "Checking", status: "checking" },
};

/** A pending row has no attempt; a recorded worker start still rules out "Not started". */
export function taskStatus(task: ReviewTask): { label: string; status: Status } {
  return task.status === "pending" && task.threads.worker
    ? { label: "No result recorded", status: "waiting" }
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
