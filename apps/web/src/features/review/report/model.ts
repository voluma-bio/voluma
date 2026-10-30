/**
 * The review's data is the shared contract (`@voluma/contracts/review`), loaded by
 * `getReviewRun`. Display helpers leave scientific task status unchanged.
 */
import type { TaskStatus } from "@voluma/contracts/ids";
import type { ReviewRun, ReviewTask } from "@voluma/contracts/review";
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

/** Whether a file the latest results draw is still being converted for viewing (no entry yet). */
export function preparing(run: ReviewRun): boolean {
  const latest = run.revisions.at(-1);
  if (!latest) return false;
  const files = [
    ...latest.volumes.flatMap((v) => (v.data?.format === "npy" ? [v.data.sha256] : [])),
    ...latest.structures.flatMap((s) =>
      s.voxels && "mask" in s.voxels ? [s.voxels.mask.sha256] : [],
    ),
    ...latest.surfaces.map((s) => s.heights.sha256),
  ];
  return files.some((sha256) => !run.assets[sha256]);
}
