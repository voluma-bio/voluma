/** Human review overlays scientific results; it never changes the scientific fold. */
import type { RunEvent } from "./events";
import { corrections, type FoldedTask, fold } from "./fold";
import type { TaskState, TaskStatus } from "./ids";
import type { ReviewSummary, Unacceptable } from "./review";
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
        acceptable: progress(latest).acceptable,
        needsYou: latest.tasks.reduce((n, task) => n + openItems(task), 0),
        reviewedAt: completed?.createdAt ?? null,
      }
    : null;
  return { revisions, summary, assets: folded.assets };
}

/**
 * How far a revision got, as Home, the study and the run page all count it: tasks done of the
 * plan's (To check counts, a skipped task among them: its work is over), and the open checks a
 * person can accept (`acceptable`: what "Looks right" and Mark reviewed read, not what a screen
 * calls To check; that is `openItems`).
 */
export function progress(revision: {
  tasks: readonly { status: TaskStatus; checks: readonly { status: string }[] }[];
  plan: { tasks: readonly unknown[] };
}): { done: number; total: number; acceptable: number } {
  return {
    done: revision.tasks.filter((t) => t.status === "done" || t.status === "to-check").length,
    total: revision.plan.tasks.length,
    acceptable: revision.tasks.reduce(
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

/** What `cardWithoutCheck` and `openItems` read of a folded task. */
type ItemFacts = Pick<FoldedTask, "status" | "checks" | "rejected" | "checker" | "missingRequired">;

/**
 * A To check task with no check gets one card nobody can accept, saying why: the second AI sent
 * it back, values are missing, or the AI marked it. Null for any other task. The scan review
 * draws the card; the study read counts it.
 */
export function cardWithoutCheck(task: ItemFacts): Unacceptable | null {
  if (task.status !== "to-check" || task.checks.length > 0) return null;
  if (task.rejected || task.checker?.verdict === "needs-review") return "sent-back";
  if (task.missingRequired.length > 0) return "values-missing";
  return "marked";
}

/**
 * A task's items that need a person, as the scan review counts them: its checks not yet
 * accepted, or its card without a check (`cardWithoutCheck`). A done task can still carry open
 * checks. What every screen calls To check; `progress().acceptable` is only the accept flow's.
 */
export function openItems(task: ItemFacts): number {
  if (cardWithoutCheck(task)) return 1;
  return task.checks.filter((check) => check.status !== "accepted").length;
}

/**
 * A scan's newest run as the scan review shows its tasks, for the study read: each plan task's
 * state (`taskStates`), its items that need a person where it has any (`openItems`), and why a
 * card without a check is there. `revision` is the one the review reads (`latestRevision`); no
 * run, or no plan yet, reads as no tasks.
 */
export function shownTasks(
  newest:
    | (Parameters<typeof taskStates>[1] & {
        revision:
          | {
              tasks: readonly (StateFacts & ItemFacts)[];
              plan: { tasks: readonly { id: string; dependsOn: readonly string[] }[] };
            }
          | undefined;
      })
    | undefined,
): {
  taskState: Record<string, TaskState>;
  needsYou: Record<string, number>;
  unacceptable: Record<string, Unacceptable>;
} {
  const revision = newest?.revision;
  if (!revision) return { taskState: {}, needsYou: {}, unacceptable: {} };
  const { tasks } = revision;
  return {
    taskState: Object.fromEntries(taskStates(revision, newest)),
    needsYou: Object.fromEntries(
      tasks.flatMap((t) => {
        const n = openItems(t);
        return n > 0 ? [[t.id, n]] : [];
      }),
    ),
    unacceptable: Object.fromEntries(
      tasks.flatMap((t) => {
        const why = cardWithoutCheck(t);
        return why ? [[t.id, why]] : [];
      }),
    ),
  };
}

/**
 * The revision the scan review reads: a correction in progress's own, else the latest. The
 * study read takes its task states and items from the same one.
 */
export const latestRevision = <R>(fold: {
  results: { revisions: readonly R[] };
  correcting: R | undefined;
}): R | undefined => fold.correcting ?? fold.results.revisions.at(-1);

/**
 * What needs a person on a scan, the count Home, the study pages and the queues call To check:
 * its newest run's items (`ReviewSummary.needsYou`) when that run completed, else the acceptable
 * checks of its newest completed result (a live or stopped rerun's items show on its tasks only).
 */
export const scanNeedsYou = (newest: Pick<ReviewSummary, "needsYou"> | null, acceptable: number) =>
  newest ? newest.needsYou : acceptable;

/** What `taskStates` reads of a folded task. */
export type StateFacts = Pick<FoldedTask, "id" | "status" | "skipped" | "satisfied" | "threads">;

/** What `taskStates` reads of the run's state (`RunState`): its status, and an ended run's outcome. */
export type RunStateFacts =
  | { status: "queued" | "running" | "awaiting-keys" }
  | Pick<Extract<RunState, { status: "ended" }>, "status" | "outcome">;

/**
 * Where the run stands, as far as its tasks' states need it: `stopped` once it has ended,
 * `waiting` while it waits in line for a runner, `paused` while it waits for its starter's keys,
 * none while it runs.
 */
type RunHalt = "stopped" | "waiting" | "paused" | undefined;

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
    halt: {
      ended: "stopped" as const,
      queued: "waiting" as const,
      "awaiting-keys": "paused" as const,
      running: undefined,
    }[state.status],
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
