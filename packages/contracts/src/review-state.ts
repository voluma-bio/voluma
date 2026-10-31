/** Human review overlays scientific results; it never changes the scientific fold. */
import type { RunEvent } from "./events";
import { corrections, type FoldedTask, fold } from "./fold";
import type { TaskState, TaskStatus } from "./ids";
import type { ReviewSummary } from "./review";
import type { RunState } from "./run";

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
 * An open correction's revision, which task states read while it runs: `reviewState(events)`
 * holds it back, so values and checks stay on the last completed result. Undefined when no
 * correction is open: both folds' latest revision is then the same.
 */
export function openCorrectionRevision(events: readonly RunEvent[]) {
  return corrections(events).open
    ? reviewState(events, { live: true }).revisions.at(-1)
    : undefined;
}

/** What `taskStates` reads of a folded task. */
export type StateFacts = Pick<FoldedTask, "id" | "status" | "skipped" | "satisfied" | "threads">;

/** What `taskStates` reads of the run's state (`RunState`): its status, and an ended run's outcome. */
export type RunStateFacts =
  | { status: "queued" | "running" | "awaiting-keys" }
  | Pick<Extract<RunState, { status: "ended" }>, "status" | "outcome">;

/**
 * Where the run stands, as far as its tasks' states need it: `stopped` once it has ended,
 * `paused` while it waits for a runner or keys, none while it runs.
 */
type RunHalt = "stopped" | "paused" | undefined;

/**
 * Every plan task's state, the one rule the scan review and the study both show. It reads fold
 * fields only (status, skipped, satisfied, the attempt's threads), never a sentence, and the run's
 * `state`. `open`: the threads started and not ended (`openThreads`); they run only while the run
 * does. `failed`: the threads whose latest end failed (`failedThreads`); they count only when the
 * run failed, since a fatal provider error fails the run with no task event, so the task whose AI
 * failed is the one it failed on. Read the revision a correction in progress is writing, not the
 * one `reviewState` holds (`openCorrectionRevision`).
 */
export function taskStates(
  revision: {
    tasks: readonly StateFacts[];
    plan: { tasks: readonly { id: string; dependsOn: readonly string[] }[] };
  },
  {
    state,
    open,
    failed,
  }: {
    state: RunStateFacts;
    open: Iterable<string>;
    failed: ReadonlySet<string>;
  },
): Map<string, TaskState> {
  const run: RunNow = {
    running: new Set(state.status === "running" ? open : []),
    failed: state.status === "ended" && state.outcome === "failed" ? failed : new Set(),
    halt: state.status === "ended" ? "stopped" : state.status === "running" ? undefined : "paused",
  };
  const byId = new Map(revision.tasks.map((t) => [t.id, t]));
  return new Map(
    revision.plan.tasks.map((p) => {
      const t = byId.get(p.id);
      const blocked = p.dependsOn.some((d) => !byId.get(d)?.satisfied);
      return [p.id, stateOf(t, blocked, run)];
    }),
  );
}

type RunNow = { running: ReadonlySet<string>; failed: ReadonlySet<string>; halt: RunHalt };

function stateOf(
  t: StateFacts | undefined,
  blocked: boolean,
  { running, failed, halt }: RunNow,
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
