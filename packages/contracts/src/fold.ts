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
 * - A check thread's checkpoints join the attempt it checks without changing
 *   its outputs. Outputs are the latest `output` per `outputId`; evidence is
 *   unique by sha256. A `verdict` counts only from a check thread.
 * - The last step sends each output to its review block, with the id
 *   `${taskId}/${outputId}`: `measurement` to `measurements`, `score` to
 *   `scores`, `file` to `files` (its `title` is its name), and `structure`, `annotation` and `volume` to
 *   the revision's `structures`, `annotations` and `volumes`. A reference to
 *   another output (operands, `structureIds`, `annotationIds`, a structure's
 *   `volume`, an annotation's `volume`) is resolved to that id by one resolver
 *   keyed by block kind (`volume:labels` is not `volume:image`). One that
 *   doesn't resolve in the revision is dropped: a structure's `voxels` becomes
 *   null, an annotation's `volumeId` null, which means the scan (the API fills
 *   its id). So no later attempt of another task can leave a dangling id.
 * - The plan is the first `revision.started`'s. An output fills a declaration
 *   of its kind (a volume, also of its volume kind). Per task, `undeclared` is
 *   the ids of the outputs that fill none; `missing` the declared outputs the
 *   current attempt hasn't reported, except structures, and `missingRequired`
 *   the required ones among all of them. A declared structure not reported is
 *   emitted as a `Structure` with status `missing`.
 * - `resultRevisionId` is the revision in which the task's latest event so far
 *   was appended.
 * - To check items (all open; accepting one is the review lane's, and a check
 *   never clears one): each `toCheck` checkpoint; "Marked to check", an
 *   attempt-level flag that the latest `to-check` event not written by
 *   `check-result` sets and a later `in-progress`, `done`, `stale` or `failed`
 *   clears (`under-review` and `check-result` leave it), its id that event's.
 *   A `toCheck` may carry a `focus`: its ids go through the reference resolver
 *   and are dropped if they don't resolve (a `label` goes with its `volumeId`);
 *   one left pointing at nothing is absent. "Marked to check" has no focus.
 *   `checkResult` turns a folded task into the status `check-result` gives.
 * - Not from these events (the API adds them): `title`, `ask`,
 *   `structureIds`, `threads.chat`, revision labels, the scan's volume; the API
 *   also sets each asset's `stage` to the task title (here the task id).
 */
import type { RunEvent, ThreadKind } from "./events";
import type { TaskStatus } from "./ids";
import type { EvidenceRef, Output } from "./output";
import { evidenceKey } from "./r2";
import type {
  Annotation,
  Asset,
  Focus,
  Measurement,
  ReviewTask,
  Score,
  Structure,
  Volume,
} from "./review";
import type { DeclaredOutput } from "./workflow";

type OutputEvent = Extract<RunEvent, { type: "output" }>;

/** The block an output fills, for resolving references; a `volume` is told apart by its own kind. */
type RefKind = "measurement" | "structure" | "annotation" | "volume:image" | "volume:labels";

const refKind = (o: Output): RefKind | undefined =>
  o.kind === "volume"
    ? `volume:${o.volume.kind}`
    : o.kind === "score" || o.kind === "file"
      ? undefined
      : o.kind;

/** Whether a reported output fills a declaration: the same kind, and for a volume the same volume kind. */
const fills = (d: DeclaredOutput, o: Output) =>
  d.kind === o.kind &&
  (d.kind !== "volume" || (o.kind === "volume" && d.volumeKind === o.volume.kind));
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
  | "dependsOn"
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
  /** Ids of the required declared outputs, of any kind (structures too), the attempt hasn't reported. */
  missingRequired: string[];
  /** The latest `task` event's reason; null while the attempt has none. */
  reason: string | null;
  threads: Pick<ReviewTask["threads"], "worker" | "check">;
  models: Pick<ReviewTask["models"], "worker" | "check">;
  milestones: Milestone[];
};

export type FoldedRevision = {
  id: string;
  createdAt: string;
  reason: "run" | "correction";
  taskId?: string;
  tasks: FoldedTask[];
  volumes: Volume[];
  structures: Structure[];
  annotations: FoldedAnnotation[];
};

/** An annotation as reported: a null `volumeId` is the scan, whose id the API knows. */
export type FoldedAnnotation = Annotation extends infer A
  ? A extends Annotation
    ? Omit<A, "volumeId"> & { volumeId: string | null }
    : never
  : never;

/**
 * The status the runtime's `check-result` rule gives a task whose check thread
 * ended, computed from `fold` of the log: `done` only for a `passed` verdict
 * with nothing open and no required output missing, otherwise `to-check`.
 */
export function checkResult(
  t: Pick<FoldedTask, "checker" | "checks" | "missingRequired">,
): "done" | "to-check" {
  return t.checker?.verdict === "passed" && t.checks.length === 0 && t.missingRequired.length === 0
    ? "done"
    : "to-check";
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
  checker: ReviewTask["checker"];
  outputs: Map<string, OutputEvent>;
  evidence: Map<string, Asset>;
};

export function fold(events: readonly RunEvent[]): Folded {
  const threadKind = new Map<string, ThreadKind>();
  const threadModel = new Map<string, string>();
  const attempts = new Map<string, Attempt>();
  const current = new Map<string, Attempt>();
  const revisions: FoldedRevision[] = [];
  let header: Pick<FoldedRevision, "id" | "createdAt" | "reason" | "taskId"> | undefined;
  // taskId → outputId → declaration, from the run's first event.
  const plan = new Map<string, Map<string, DeclaredOutput>>();
  const dependsOn = new Map<string, string[]>();
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
    const kinds = new Map<string, RefKind>();
    for (const a of current.values())
      for (const [id, v] of a.outputs) {
        const k = refKind(v.payload.output);
        if (k) kinds.set(`${a.taskId}/${id}`, k);
      }
    // The one guarantee for references: one that doesn't resolve to an output of
    // an accepted block kind in this revision is dropped (`undefined`).
    const ref = (a: Attempt, id: string | undefined, ...accept: RefKind[]) => {
      if (id === undefined) return undefined;
      const full = id.includes("/") ? id : `${a.taskId}/${id}`;
      const k = kinds.get(full);
      return k && accept.includes(k) ? full : undefined;
    };
    const refs = (a: Attempt, ids: string[], kind: RefKind) =>
      ids.flatMap((id) => ref(a, id, kind) ?? []);
    // Ids that resolve stay; `label` goes with a `volumeId` that doesn't. A focus
    // left pointing at nothing is absent: the whole task.
    const resolveFocus = (a: Attempt, f: Focus): Focus | undefined => {
      const volumeId = ref(a, f.volumeId, "volume:labels");
      const { volumeId: _v, label, ...rest } = f;
      const resolved = {
        ...rest,
        structureIds: refs(a, f.structureIds, "structure"),
        annotationIds: refs(a, f.annotationIds, "annotation"),
        ...(volumeId !== undefined && { volumeId, ...(label !== undefined && { label }) }),
      };
      const points =
        resolved.structureIds.length + resolved.annotationIds.length > 0 ||
        volumeId !== undefined ||
        resolved.box ||
        resolved.point;
      return points ? resolved : undefined;
    };
    const volumes: Volume[] = [];
    const structures: Structure[] = [];
    const annotations: FoldedAnnotation[] = [];
    const tasks = [...current.values()].map((a) => {
      const measurements: Measurement[] = [];
      const scores: Score[] = [];
      const files: Asset[] = [];
      const undeclared: string[] = [];
      const declaredOutputs = [...(plan.get(a.taskId)?.values() ?? [])];
      for (const [outputId, v] of a.outputs) {
        const { payload: p } = v;
        const { output: o } = p;
        const id = `${a.taskId}/${outputId}`;
        const decl = plan.get(a.taskId)?.get(outputId);
        const declared = decl !== undefined && fills(decl, o);
        // A structure records this as `declared` on its block; listing it here too would be a second copy.
        if (!declared && o.kind !== "structure") undeclared.push(id);
        const key = (sha: string) => evidenceKey(v.runId, sha);
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
              confidence: o.confidence,
              ...(o.note !== undefined && { note: o.note }),
              ...(o.definition !== undefined && { definition: o.definition }),
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
              confidence: o.confidence,
              ...(o.note !== undefined && { note: o.note }),
              ...(o.definition !== undefined && { definition: o.definition }),
              evidenceIds,
              structureIds: refs(a, o.structureIds, "structure"),
              annotationIds: refs(a, o.annotationIds, "annotation"),
              source,
            });
            break;
          case "structure": {
            const volumeId = ref(a, o.volume, "volume:labels");
            structures.push({
              id,
              name: p.title,
              voxels:
                volumeId === undefined
                  ? null
                  : { volumeId, ...(o.label !== undefined && { label: o.label }) },
              declared,
              status: o.status ?? null,
              reason: o.reason ?? null,
              ...(o.definition !== undefined && { definition: o.definition }),
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
              volumeId: ref(a, o.volume, "volume:labels", "volume:image") ?? null,
              ...(o.note !== undefined && { note: o.note }),
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
              name: p.title,
              stage: a.taskId,
              key: key(o.file.sha256),
              sha256: o.file.sha256,
              mediaType: o.mediaType,
            });
            break;
        }
      }
      const unreported = declaredOutputs.filter((d) => {
        const o = a.outputs.get(d.id)?.payload.output;
        return !(o && fills(d, o));
      });
      // A declared structure never reported is a `missing` structure, so the
      // Structures panel is complete; `missing` lists the kinds with no such slot.
      for (const d of unreported)
        if (d.kind === "structure")
          structures.push({
            id: `${a.taskId}/${d.id}`,
            name: d.name ?? d.id,
            voxels: null,
            declared: true,
            status: "missing",
            reason: `The workflow declares it${d.required ? " as required" : ""}; the task has not reported it.`,
          });
      const missing = unreported.flatMap((d) =>
        d.kind === "structure" ? [] : [{ outputId: d.id, kind: d.kind, required: d.required }],
      );
      const missingRequired = unreported.filter((d) => d.required).map((d) => d.id);
      const checks: Check[] = a.toChecks.map(({ focus, ...c }) => {
        const f = focus && resolveFocus(a, focus);
        return { ...c, ...(f && { focus: f }) };
      });
      if (a.flag)
        checks.push({
          id: a.flag.id,
          title: "Marked to check",
          detail: a.flag.reason,
          status: "open",
        });
      return {
        id: a.taskId,
        // Only dependencies that have a row: a worker can open a task before its dependency.
        dependsOn: (dependsOn.get(a.taskId) ?? []).filter((d) => current.has(d)),
        attemptId: a.id,
        status: a.status,
        reason: a.reason,
        resultRevisionId: a.resultRevisionId,
        checker: a.checker && { ...a.checker },
        threads: { worker: a.workerThread, check: a.checkThread },
        models: {
          worker: threadModel.get(a.workerThread) ?? null,
          check: a.checkThread ? (threadModel.get(a.checkThread) ?? null) : null,
        },
        milestones: a.milestones.map((m) => ({ ...m, evidenceIds: [...m.evidenceIds] })),
        measurements,
        scores,
        files,
        missing,
        missingRequired,
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
        if (e.payload.model) threadModel.set(e.threadId, e.payload.model);
        const checked = e.payload.attemptId && attempts.get(e.payload.attemptId);
        // A wake re-emits `thread.started` for the same thread: only a new check thread resets the verdict.
        if (e.payload.kind === "check" && checked && checked.checkThread !== e.threadId) {
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
          for (const t of p.plan.tasks) {
            plan.set(t.id, new Map(t.outputs.map((o) => [o.id, o])));
            dependsOn.set(t.id, t.dependsOn);
          }
        header =
          p.reason === "run"
            ? { id: e.id, createdAt: e.createdAt, reason: p.reason }
            : { id: e.id, createdAt: e.createdAt, reason: p.reason, taskId: p.taskId };
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
          a.toChecks.push({
            id: e.id,
            title: toCheck.title,
            detail: text,
            status: "open",
            ...(toCheck.focus && { focus: toCheck.focus }),
          });
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
