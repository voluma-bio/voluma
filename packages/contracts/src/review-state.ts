/** Human review overlays scientific results; it never changes the scientific fold. */
import type { RunEvent } from "./events";
import { type FoldedTask, fold } from "./fold";
import type { TaskState, TaskStatus } from "./ids";
import type { ReviewSummary } from "./review";

/**
 * `live`: include a correction still in progress (the run page's progress). Without it review
 * keeps the last completed revision until the correction finishes (`abandonedEvents`, fold.ts).
 */
export function reviewState(events: readonly RunEvent[], { live = false } = {}) {
  const folded = fold(events, !live);
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

/**
 * Where the run stands, as far as its tasks' states need it: `stopped` once it has ended,
 * `paused` while it waits for a runner or keys, none while it runs.
 */
/** What `taskStates` reads of a folded task. */
export type StateFacts = Pick<FoldedTask, "id" | "status" | "skipped" | "satisfied" | "threads">;

export type RunHalt = "stopped" | "paused" | undefined;

/**
 * Every plan task's state, the one rule the scan review and the study both show. It reads fold
 * fields only (status, skipped, satisfied, the attempt's threads), never a sentence. `running`:
 * the threads running now (`openThreads` while the run runs, else none). `failed`: the threads
 * that ended failed when the run failed, else none: a fatal provider error fails the run with no
 * task event, so the task whose AI failed is the one it failed on.
 */
export function taskStates(
  revision: {
    tasks: readonly StateFacts[];
    plan: { tasks: readonly { id: string; dependsOn: readonly string[] }[] };
  },
  run: { running: ReadonlySet<string>; failed: ReadonlySet<string>; halt: RunHalt },
): Map<string, TaskState> {
  const byId = new Map(revision.tasks.map((t) => [t.id, t]));
  return new Map(
    revision.plan.tasks.map((p) => {
      const t = byId.get(p.id);
      const blocked = p.dependsOn.some((d) => !byId.get(d)?.satisfied);
      return [p.id, stateOf(t, blocked, run)];
    }),
  );
}

function stateOf(
  t: StateFacts | undefined,
  blocked: boolean,
  { running, failed, halt }: Parameters<typeof taskStates>[1],
): TaskState {
  const status = t?.status;
  if (t?.skipped) return "skipped";
  if (status === "done" || status === "to-check" || status === "failed") return status;
  const { worker, check } = t?.threads ?? {};
  if ((worker && failed.has(worker)) || (check && failed.has(check))) return "failed";
  const started = status === "in-progress" || status === "under-review";
  if (halt && started) return halt;
  if (worker && running.has(worker)) return "running";
  if (status === "under-review" && check && running.has(check)) return "checking";
  if (started) return "held";
  return blocked ? "waiting" : "ready";
}
