/**
 * The fold: the one place the run's `task`, `checkpoint` and `value` events
 * become the run screen's rows and the review's tasks and revisions. The
 * runtime's per-task record, the run screen and the API's `ReviewRun` all call
 * it. It is pure: events in `seq` order in, plain data out. The rules the
 * runtime keeps are in `task-tools.ts`.
 *
 * - A revision runs from its `revision.started` event until the next one; its
 *   `id` and `createdAt` are that event's. Revision *k* is the fold of every
 *   event before revision *k+1* starts, so a task's `status` there is its
 *   status at that point. The last revision is the fold of the whole log.
 * - A task has no row until it has an attempt (`attempt.opened`). Its current
 *   attempt is the latest one; events join the attempt they are stamped with.
 *   Attempt status: the latest stamped `task` event, otherwise `in-progress`.
 * - A check thread's events join the attempt it checks, so a fix lands in the
 *   worker's attempt: the earlier revision holds the result as the check found
 *   it. Outputs are the latest `value` per `measurementId`; evidence is unique
 *   by sha256. A `verdict` counts only from a check thread.
 * - `resultRevisionId` is the revision in which the task's latest event so far
 *   was appended.
 * - To check items (all open; accepting one is the review lane's, and a check
 *   never clears one): each `toCheck` checkpoint; "Marked to check", an
 *   attempt-level flag that the latest `to-check` event not written by
 *   `check-result` sets and a later `in-progress`, `done`, `stale` or `failed`
 *   clears (`under-review` and `check-result` leave it), its id that event's;
 *   and "Changed by the second agent" for each fix revision on the attempt.
 *   `checkResult` turns a folded task into the status `check-result` gives.
 * - Not from these events (the API adds them): `title`, `ask`, `dependsOn`,
 *   `structureIds`, `files`, `threads.chat`, revision labels; the API also
 *   sets each asset's `stage` to the task title (here the task id) and drops a
 *   `structureIds`/`annotationIds` entry the revision doesn't contain.
 */
import type { EvidenceRef, RunEvent, TaskStatus, ThreadKind } from "./events";
import { evidenceKey } from "./r2";
import type { Asset, Measurement, ReviewTask } from "./review";

type ValueEvent = Extract<RunEvent, { type: "value" }>;
type Check = ReviewTask["checks"][number];

export type Milestone = {
  id: string;
  text: string;
  /** Set only on a check thread's checkpoint. */
  verdict?: "passed" | "needs-review";
  /** `Asset.id`s (sha256) of the files it cites. */
  evidenceIds: string[];
};

/** A task's current attempt in one revision: the `ReviewTask` parts the events decide, plus what the run screen shows. */
export type FoldedTask = Pick<
  ReviewTask,
  "id" | "status" | "resultRevisionId" | "checker" | "measurements" | "checks" | "evidence"
> & {
  attemptId: string;
  /** The latest `task` event's reason; null while the attempt has none. */
  reason: string | null;
  threads: Pick<ReviewTask["threads"], "worker" | "check">;
  milestones: Milestone[];
};

export type FoldedRevision = {
  id: string;
  createdAt: string;
  reason: "run" | "correction" | "fix";
  taskId?: string;
  tasks: FoldedTask[];
};

/**
 * The status the runtime's `check-result` rule gives a task whose check thread
 * ended, computed from `fold` of the log: `done` only for a `passed` verdict
 * with nothing open, otherwise `to-check`.
 */
export function checkResult(t: Pick<FoldedTask, "checker" | "checks">): "done" | "to-check" {
  return t.checker?.verdict === "passed" && t.checks.length === 0 ? "done" : "to-check";
}

export type Folded = {
  /** The run now: the last revision's tasks. */
  tasks: FoldedTask[];
  /** Oldest first. Empty until the run's first `revision.started`. */
  revisions: FoldedRevision[];
};

type Attempt = {
  id: string;
  taskId: string;
  workerThread: string;
  checkThread: string | null;
  status: TaskStatus;
  reason: string | null;
  /** "Marked to check": the event that set it and its reason. */
  flag: { id: string; reason: string } | null;
  resultRevisionId: string;
  milestones: Milestone[];
  toChecks: Check[];
  fixes: string[];
  checker: ReviewTask["checker"];
  outputs: Map<string, ValueEvent>;
  evidence: Map<string, Asset>;
};

export function fold(events: readonly RunEvent[]): Folded {
  const threadKind = new Map<string, ThreadKind>();
  const attempts = new Map<string, Attempt>();
  const current = new Map<string, Attempt>();
  const revisions: FoldedRevision[] = [];
  let header: Omit<FoldedRevision, "tasks"> | undefined;
  // The run's first event is `revision.started` (`task-tools.ts`).
  let revisionId = "";

  const addEvidence = (a: Attempt, runId: string, refs: EvidenceRef[]) => {
    for (const r of refs)
      a.evidence.set(r.sha256, {
        id: r.sha256,
        name: r.path,
        stage: a.taskId,
        key: evidenceKey(runId, r.sha256),
        sha256: r.sha256,
      });
  };

  const snapshot = (): FoldedTask[] => {
    const known = new Set<string>();
    for (const a of current.values())
      for (const m of a.outputs.keys()) known.add(`${a.taskId}/${m}`);
    // An operand the revision doesn't contain is dropped.
    const operand = (a: Attempt, id: string | undefined) => {
      if (id === undefined) return undefined;
      const full = id.includes("/") ? id : `${a.taskId}/${id}`;
      return known.has(full) ? full : undefined;
    };
    return [...current.values()].map((a) => {
      const measurements = [...a.outputs.values()].map((v): Measurement => {
        const { payload: p } = v;
        const numeratorId = operand(a, p.numeratorId);
        const denominatorId = operand(a, p.denominatorId);
        return {
          id: `${a.taskId}/${p.measurementId}`,
          title: p.title,
          value: p.value,
          unit: p.unit,
          confidence: p.confidence,
          ...(p.note !== undefined && { note: p.note }),
          ...(p.definition !== undefined && { definition: p.definition }),
          evidenceIds: p.evidence.map((r) => r.sha256),
          references: [],
          structureIds: p.structureIds,
          annotationIds: p.annotationIds,
          ...(numeratorId !== undefined && { numeratorId }),
          ...(denominatorId !== undefined && { denominatorId }),
          source: { threadId: v.threadId, eventId: v.id },
        };
      });
      const checks: Check[] = a.toChecks.map((c) => ({ ...c }));
      if (a.flag)
        checks.push({
          id: a.flag.id,
          title: "Marked to check",
          detail: a.flag.reason,
          status: "open",
        });
      for (const id of a.fixes)
        checks.push({
          id,
          title: "Changed by the second agent",
          detail: "The check changed this result. Its checkpoints say what and why.",
          status: "open",
        });
      return {
        id: a.taskId,
        attemptId: a.id,
        status: a.status,
        reason: a.reason,
        resultRevisionId: a.resultRevisionId,
        checker: a.checker && { ...a.checker },
        threads: { worker: a.workerThread, check: a.checkThread },
        milestones: a.milestones.map((m) => ({ ...m, evidenceIds: [...m.evidenceIds] })),
        measurements,
        checks,
        evidence: [...a.evidence.values()],
      };
    });
  };

  for (const e of events) {
    switch (e.type) {
      case "thread.started": {
        threadKind.set(e.threadId, e.payload.kind);
        const checked = e.payload.attemptId && attempts.get(e.payload.attemptId);
        if (e.payload.kind === "check" && checked) {
          checked.checkThread = e.threadId;
          checked.checker = null; // the verdict shown is this check's
        }
        break;
      }
      case "revision.started": {
        if (header) revisions.push({ ...header, tasks: snapshot() });
        revisionId = e.id;
        const { payload: p } = e;
        header =
          p.reason === "run"
            ? { id: e.id, createdAt: e.createdAt, reason: p.reason }
            : { id: e.id, createdAt: e.createdAt, reason: p.reason, taskId: p.taskId };
        if (p.reason === "fix") current.get(p.taskId)?.fixes.push(e.id);
        break;
      }
      case "attempt.opened": {
        const a: Attempt = {
          id: e.id,
          taskId: e.payload.taskId,
          workerThread: e.threadId,
          checkThread: null,
          status: "in-progress",
          reason: null,
          flag: null,
          resultRevisionId: revisionId,
          milestones: [],
          toChecks: [],
          fixes: [],
          checker: null,
          outputs: new Map(),
          evidence: new Map(),
        };
        attempts.set(e.id, a);
        current.set(a.taskId, a);
        break;
      }
      case "task": {
        const a = attempts.get(e.payload.attemptId);
        if (!a) break;
        const { status, reason, by } = e.payload;
        a.status = status;
        a.reason = reason;
        if (status === "to-check") {
          if (!(by.kind === "rule" && by.rule === "check-result")) a.flag = { id: e.id, reason };
        } else if (status !== "under-review") a.flag = null;
        a.resultRevisionId = revisionId;
        break;
      }
      case "checkpoint": {
        const a = attempts.get(e.payload.attemptId);
        if (!a) break;
        const { text, verdict, toCheck, evidence } = e.payload;
        const byCheck = threadKind.get(e.threadId) === "check";
        addEvidence(a, e.runId, evidence);
        a.milestones.push({
          id: e.id,
          text,
          ...(byCheck && verdict && { verdict }),
          evidenceIds: evidence.map((r) => r.sha256),
        });
        if (byCheck && verdict) a.checker = { verdict, text };
        if (toCheck)
          a.toChecks.push({ id: e.id, title: toCheck.title, detail: text, status: "open" });
        a.resultRevisionId = revisionId;
        break;
      }
      case "value": {
        const a = attempts.get(e.payload.attemptId);
        if (!a) break;
        addEvidence(a, e.runId, e.payload.evidence);
        a.outputs.set(e.payload.measurementId, e);
        a.resultRevisionId = revisionId;
        break;
      }
      default:
        break;
    }
  }

  const tasks = snapshot();
  if (header) revisions.push({ ...header, tasks });
  return { tasks, revisions };
}
