/**
 * The fold: the one place the run's `task`, `checkpoint` and `output` events
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
 *   it. Outputs are the latest `output` per `outputId`; evidence is unique by
 *   sha256. A `verdict` counts only from a check thread.
 * - The last step sends each output to its review block, with the id
 *   `${taskId}/${outputId}`: `measurement` to `measurements`, `score` to
 *   `scores`, `file` to `files`, and `structure`, `annotation` and `volume` to
 *   the revision's `structures`, `annotations` and `volumes`. A reference to
 *   another output (operands, `structureIds`, `annotationIds`, a structure's
 *   `volume`, an annotation's `volumeId`) is resolved to that id, and dropped
 *   if the revision has no such output of the right kind (an annotation's
 *   `volumeId` then stays as given: it may be the scan's).
 * - The plan is the first `revision.started`'s. Per task, `missing` is the
 *   declared outputs the current attempt hasn't reported and `undeclared` the
 *   ids of the outputs the plan doesn't declare; `Structure.declared` follows.
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
 *   `structureIds`, `threads.chat`, revision labels, the scan's volume; the API
 *   also sets each asset's `stage` to the task title (here the task id).
 */
import type { RunEvent, ThreadKind } from "./events";
import type { EvidenceRef } from "./output";
import { evidenceKey } from "./r2";
import type {
  Annotation,
  Asset,
  Measurement,
  ReviewTask,
  Score,
  Structure,
  Volume,
} from "./review";
import type { DeclaredOutput, OutputKind, TaskStatus } from "./workflow";

type OutputEvent = Extract<RunEvent, { type: "output" }>;
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
  | "id"
  | "status"
  | "resultRevisionId"
  | "checker"
  | "measurements"
  | "scores"
  | "files"
  | "missing"
  | "undeclared"
  | "checks"
  | "evidence"
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
  volumes: Volume[];
  structures: Structure[];
  annotations: Annotation[];
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
  outputs: Map<string, OutputEvent>;
  evidence: Map<string, Asset>;
};

export function fold(events: readonly RunEvent[]): Folded {
  const threadKind = new Map<string, ThreadKind>();
  const attempts = new Map<string, Attempt>();
  const current = new Map<string, Attempt>();
  const revisions: FoldedRevision[] = [];
  let header: Pick<FoldedRevision, "id" | "createdAt" | "reason" | "taskId"> | undefined;
  // taskId → outputId → declaration, from the run's first event.
  const plan = new Map<string, Map<string, DeclaredOutput>>();
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

  const snapshot = (): Pick<FoldedRevision, "tasks" | "volumes" | "structures" | "annotations"> => {
    const kinds = new Map<string, OutputKind>();
    for (const a of current.values())
      for (const [id, v] of a.outputs) kinds.set(`${a.taskId}/${id}`, v.payload.output.kind);
    // A reference the revision doesn't contain, or of the wrong kind, is dropped.
    const ref = (a: Attempt, id: string | undefined, kind: OutputKind) => {
      if (id === undefined) return undefined;
      const full = id.includes("/") ? id : `${a.taskId}/${id}`;
      return kinds.get(full) === kind ? full : undefined;
    };
    const refs = (a: Attempt, ids: string[], kind: OutputKind) =>
      ids.flatMap((id) => ref(a, id, kind) ?? []);
    const volumes: Volume[] = [];
    const structures: Structure[] = [];
    const annotations: Annotation[] = [];
    const tasks = [...current.values()].map((a) => {
      const measurements: Measurement[] = [];
      const scores: Score[] = [];
      const files: Asset[] = [];
      const undeclared: string[] = [];
      for (const [outputId, v] of a.outputs) {
        const { payload: p } = v;
        const { output: o } = p;
        const id = `${a.taskId}/${outputId}`;
        const decl = plan.get(a.taskId)?.get(outputId);
        const declared = decl?.kind === o.kind;
        if (!declared) undeclared.push(id);
        const key = (sha: string) => evidenceKey(v.runId, sha);
        const note = p.note !== undefined && { note: p.note };
        const definition = p.definition !== undefined && { definition: p.definition };
        const evidenceIds = p.evidence.map((r) => r.sha256);
        const source = { threadId: v.threadId, eventId: v.id };
        switch (o.kind) {
          case "measurement": {
            const numeratorId = ref(a, o.numeratorId, "measurement");
            const denominatorId = ref(a, o.denominatorId, "measurement");
            measurements.push({
              id,
              title: p.title,
              value: o.value,
              unit: o.unit,
              confidence: p.confidence,
              ...note,
              ...definition,
              evidenceIds,
              references: [],
              structureIds: refs(a, o.structureIds, "structure"),
              annotationIds: refs(a, o.annotationIds, "annotation"),
              ...(numeratorId !== undefined && { numeratorId }),
              ...(denominatorId !== undefined && { denominatorId }),
              source,
            });
            break;
          }
          case "score":
            scores.push({
              id,
              title: p.title,
              level: o.level,
              scale: decl?.kind === "score" ? decl.levels : null,
              confidence: p.confidence,
              ...note,
              ...definition,
              evidenceIds,
              source,
            });
            break;
          case "structure": {
            const volumeId = ref(a, o.volume, "volume");
            structures.push({
              id,
              name: p.title,
              voxels:
                volumeId === undefined
                  ? null
                  : { volumeId, ...(o.label !== undefined && { label: o.label }) },
              declared,
              status: null,
              reason: null,
              ...definition,
              ...(o.volumeMm3 !== undefined && { volumeMm3: o.volumeMm3 }),
              ...(o.mesh && {
                mesh: {
                  key: key(o.mesh.file.sha256),
                  sha256: o.mesh.file.sha256,
                  vertices: o.mesh.vertices,
                  indices: o.mesh.indices,
                  centerWorldMm: o.mesh.centerWorldMm,
                },
              }),
            });
            break;
          }
          case "annotation":
            annotations.push({
              ...o.annotation,
              id,
              name: p.title,
              volumeId: ref(a, o.annotation.volumeId, "volume") ?? o.annotation.volumeId,
              ...note,
            });
            break;
          case "volume": {
            const { file, dtype, ...grid } = o.volume;
            volumes.push({
              ...grid,
              id,
              name: p.title,
              data: { format: "npy", key: key(file.sha256), sha256: file.sha256, dtype },
            });
            break;
          }
          case "file":
            files.push({
              id,
              name: o.file.path,
              stage: a.taskId,
              key: key(o.file.sha256),
              sha256: o.file.sha256,
            });
            break;
        }
      }
      const missing = [...(plan.get(a.taskId)?.values() ?? [])]
        .filter((d) => a.outputs.get(d.id)?.payload.output.kind !== d.kind)
        .map((d) => ({ outputId: d.id, kind: d.kind, required: d.required }));
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
        scores,
        files,
        missing,
        undeclared,
        checks,
        evidence: [...a.evidence.values()],
      };
    });
    return { tasks, volumes, structures, annotations };
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
        if (header) revisions.push({ ...header, ...snapshot() });
        revisionId = e.id;
        const { payload: p } = e;
        if (p.reason === "run")
          for (const t of p.plan.tasks) plan.set(t.id, new Map(t.outputs.map((o) => [o.id, o])));
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
      case "output": {
        const a = attempts.get(e.payload.attemptId);
        if (!a) break;
        addEvidence(a, e.runId, e.payload.evidence);
        a.outputs.set(e.payload.outputId, e);
        a.resultRevisionId = revisionId;
        break;
      }
      default:
        break;
    }
  }

  const last = snapshot();
  if (header) revisions.push({ ...header, ...last });
  return { tasks: last.tasks, revisions };
}
