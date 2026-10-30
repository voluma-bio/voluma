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
 * - Every task of the plan has a row, in plan order. Its current attempt is the latest
 *   one (`attempt.opened`); events join the attempt they are stamped with. Attempt status:
 *   the latest stamped `task` event, otherwise `in-progress`. A task with no attempt is
 *   `pending` with a null `attemptId`, its latest worker thread if one started, nothing
 *   reported and nothing owed (empty `missing` and `missingRequired`), and the run's first
 *   revision as its `resultRevisionId`. `title` and `ask` are the plan's; `sentBack` lists
 *   the attempts the check sent back (`rejected` when it did), and `satisfied` is
 *   `isSatisfied` of the row.
 * - A check thread's checkpoints join the attempt it checks without changing
 *   its outputs. Outputs are the latest `output` per `outputId`; evidence is
 *   unique by sha256. A `verdict` counts only from a check thread.
 * - The last step sends each output to its review block, with the id
 *   `${taskId}/${outputId}`: `measurement` to `measurements`, `score` to
 *   `scores`, `file` to `files` (its `title` is its name), and `structure`,
 *   `surface`, `annotation` and `volume` to the revision's `structures`,
 *   `surfaces`, `annotations` and `volumes`. The links are the plan's, not the
 *   report's: a measurement's or score's `on` and `context`, and the `grid` of a
 *   structure, surface or annotation, are output ids of the plan, resolved to
 *   `taskId/outputId` and kept only if that output is a block of the revision. A
 *   structure on a grid not reported has null `voxels`; a surface or annotation
 *   on one is left out. An annotation's voxels map to world mm through its grid's
 *   affine, after the revision's volumes are known. A ratio's operands and a focus's
 *   ids go through one resolver keyed by block kind (`volume:labels` is not
 *   `volume:image`); one that doesn't resolve is dropped. So no later attempt of
 *   another task can leave a dangling id. A block on a grid names that volume block as
 *   `volumeId`.
 * - The plan is the first `revision.started`'s, changed by each `plan.changed` after it
 *   (added and ad-hoc tasks join it unless their id is already in the plan, the first wins;
 *   done-when lines and instructions are appended). Each revision carries the plan as it
 *   stood at its end. `ask` and `answer` are ignored. An output fills a declaration
 *   of its kind (a volume, also of its volume kind); a `missing` output fills any declaration
 *   and counts as reported. Per task, `undeclared` is the ids of the outputs that fill none;
 *   `missing` the declared outputs the current attempt hasn't reported or reported `missing`
 *   (with the reason), and `missingRequired` the required ones among those not reported. A
 *   structure reported `missing` is a `Structure` with `missing` set and counts as reported.
 * - A skipped task (`plan.changed.skip`, kept across revisions) and every task that
 *   transitively depends on it in the plan folds as `to-check`, with every declared output
 *   missing with the reason (the dependents' reason names the skipped task), one open To check
 *   item and `skipped` set. It needs no attempt: without one it has a row with a null
 *   `attemptId`. With one, reported outputs stay and only unreported ones are missing.
 *   `skipped.from` is the task the plan skipped (the task itself, or the one it depends on).
 *   `rejected` is true when the task's latest `task` event is `check-result`'s `to-check` on a
 *   `needs-review` verdict; `isSatisfied` is false for it and for a skipped task.
 * - A correction that ended unfinished (`correction.ended`: failed, cancelled or stalled)
 *   is abandoned from its `run.reopened`: `abandonedEvents` names its task-state events
 *   (attempts, task, checkpoints, outputs, plan changes, revisions) and every reader of the
 *   log skips them, so the run is as it was before the go. Messages, replies, thread events
 *   and the reopen and end themselves stay: the harness resumes from them.
 * - `assets` is the whole log's: the latest `assets.ready` or `assets.failed` per
 *   source sha256, whatever the revision.
 * - `resultRevisionId` is the revision in which the task's latest event so far
 *   was appended.
 * - To check items (all open; accepting one is the review lane's, and a check
 *   never clears one): each `toCheck` checkpoint; "Marked to check", an
 *   attempt-level flag that the latest `to-check` event not written by
 *   `check-result` sets and a later `in-progress`, `done`, `stale` or `failed`
 *   clears (`under-review` and `check-result` leave it), its id that event's.
 *   A `toCheck` may carry a `focus`: its ids (`on`, any block kind) go through the reference resolver
 *   and are dropped if they don't resolve (a `label` goes with its `volumeId`);
 *   one left pointing at nothing is absent. "Marked to check" has no focus.
 *   `checkResult` turns a folded task into the status `check-result` gives.
 * - Not from these events (the API adds them): revision labels; the API
 *   also sets each asset's `stage` to the task title (here the task id).
 */
import type { RunEvent } from "./events";
import type { TaskStatus } from "./ids";
import { type EvidenceRef, fileRefsOf, type Output } from "./output";
import { evidenceKey } from "./r2";
import type {
  Annotation,
  Asset,
  Focus,
  Measurement,
  ReviewAssets,
  ReviewTask,
  Score,
  Structure,
  Surface,
  Volume,
} from "./review";
import { toWorld } from "./ruler";
import type { DeclaredOutput, PlanTask, WorkflowPlan } from "./workflow";

type OutputEvent = Extract<RunEvent, { type: "output" }>;

/** The block an output fills, for resolving references; a `volume` is told apart by its own kind. */
type RefKind =
  | "measurement"
  | "structure"
  | "surface"
  | "annotation"
  | "volume:image"
  | "volume:labels";

/** Every kind of block a measurement is shown on or a focus points at. */
const BLOCK_KINDS: RefKind[] = [
  "volume:image",
  "volume:labels",
  "structure",
  "surface",
  "annotation",
];

/** Whether a reported output fills a declaration: the same kind, and for a volume the same volume kind. */
const fills = (d: DeclaredOutput, o: Output) =>
  o.kind === "missing" ||
  (d.kind === o.kind &&
    (d.kind !== "volume" || (o.kind === "volume" && d.volumeKind === o.volume.kind)));
type Check = ReviewTask["checks"][number];

export type Milestone = {
  id: string;
  /** The thread that wrote the checkpoint. */
  threadId: string;
  text: string;
  /** The checkpoint's one-sentence version for the researcher, when it has one. */
  summary?: string;
  /** Set only on a check thread's checkpoint. */
  verdict?: "passed" | "needs-review";
  /** `Asset.id`s (sha256) of the files it cites. */
  evidenceIds: string[];
};

/** A task's current attempt in one revision: the `ReviewTask` parts the events decide, plus what the run screen shows. */
export type FoldedTask = Pick<
  ReviewTask,
  | "id"
  | "title"
  | "ask"
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
  /** Null for a skipped task that never had an attempt. */
  attemptId: string | null;
  /** Set when the task was skipped, or depends on one that was; `reason` is the same text, `from` the skipped task. */
  skipped?: { reason: string; from: string };
  /** The attempts the check sent back, oldest first: a later attempt redoes them. */
  sentBack: string[];
  /** `isSatisfied(this row)`: a task that builds on this one may start. */
  satisfied: boolean;
  /** The latest `task` event is the check's `to-check` on a `needs-review` verdict: the result was rejected, and a dependent must not build on it. */
  rejected: boolean;
  /** Ids of the required declared outputs, of any kind (structures too), the attempt hasn't reported. */
  missingRequired: string[];
  /** The latest `task` event's reason; null while the attempt has none. */
  reason: string | null;
  threads: Pick<ReviewTask["threads"], "worker" | "check">;
  models: Pick<ReviewTask["models"], "worker" | "check">;
  milestones: Milestone[];
  /** Paths (the part after `/scratch/`) of the scratch files its checkpoints and outputs cite. */
  citedScratch: string[];
};

export type FoldedRevision = {
  id: string;
  createdAt: string;
  reason: "run" | "correction";
  taskId?: string;
  tasks: FoldedTask[];
  volumes: Volume[];
  structures: Structure[];
  surfaces: Surface[];
  annotations: Annotation[];
  /** The plan at the end of the revision: the run's, with every `plan.changed` so far applied. */
  plan: WorkflowPlan;
};

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

/** What the plan graph needs of a task: `plan.tasks` entries fit it. */
export interface GraphTask {
  id: string;
  /** Tasks this one builds on. */
  dependsOn: readonly string[];
}

/** Every task that depends on `id`, directly or through others, in plan order. */
export function transitiveDependents(tasks: readonly GraphTask[], id: string): string[] {
  const hit = new Set([id]);
  // A fixpoint pass per level: plans are small, and this needs no ordering of the plan.
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of tasks) {
      if (!hit.has(t.id) && t.dependsOn.some((d) => hit.has(d))) {
        hit.add(t.id);
        grew = true;
      }
    }
  }
  return tasks.filter((t) => t.id !== id && hit.has(t.id)).map((t) => t.id);
}

/**
 * Whether a task that builds on this one may start: it is `done`, or `to-check` with every
 * required output present. A To check item is for the researcher in review; it must not
 * stop the run, but a task with no usable result still blocks: one that is skipped or whose
 * check rejected it (`needs-review`). `to-check` by `accept` or the `fix-limit` rule is satisfied.
 * `undefined`: no attempt yet.
 */
export function isSatisfied(
  task: Pick<FoldedTask, "status" | "missingRequired" | "skipped" | "rejected"> | undefined,
): boolean {
  if (!task || task.skipped || task.rejected) return false;
  return (
    task.status === "done" || (task.status === "to-check" && task.missingRequired.length === 0)
  );
}

export type Folded = {
  /** The run now: the last revision's tasks, one per plan task in plan order. */
  tasks: FoldedTask[];
  /** The run's plan now. */
  plan: WorkflowPlan;
  /** Oldest first. Empty until the run's first `revision.started`. */
  revisions: FoldedRevision[];
  /** Converted assets by source sha256, from the whole log. */
  assets: Record<string, ReviewAssets>;
};

/** The event types that carry a task's state: all that an abandoned correction leaves out. */
const TASK_STATE = new Set<RunEvent["type"]>([
  "attempt.opened",
  "task",
  "checkpoint",
  "output",
  "plan.changed",
  "revision.started",
]);

/**
 * One correction: what a `run.reopened` starts. A message reopens the run for one claim, so the
 * reopen and its `person.message` are written together and a span holds one message (`messages.ts`).
 */
export type Correction = {
  /** The `run.reopened` event's id. */
  reopenId: string;
  /** Index of the `run.reopened` in the log. */
  reopened: number;
  /** Index where the span stops (exclusive): its `correction.ended`, else the next reopen, else the log's end. */
  to: number;
  /**
   * `abandoned`: a `correction.ended` closed it. `finished`: the next `run.reopened` came with
   * no end between. `open`: the latest span, which a claim may still be running or have finished
   * (a finished correction leaves its span open while the run is `ended`).
   */
  closed: "abandoned" | "finished" | "open";
  /** The id of the span's `person.message`. */
  message: string | undefined;
  /**
   * The message's go: `markerAt` is the index of the loop's `revision.started` (`goMarkerId`) once
   * the main agent was told of it; `redone` is whether an attempt of the task opened since.
   */
  go: { taskId: string; markerAt: number | undefined; redone: boolean } | undefined;
  /** The `/outputs` backup (`outputs-backup.ts`): the latest `outputs.*` event keyed to this reopen. */
  backup: "none" | "backed-up" | "restored" | "discarded";
  /** A main-agent `reply` lies in the span. */
  replied: boolean;
  /** The claim finished: the root thread ended after the reopen and the span was not abandoned. */
  claimEnded: boolean;
};

/** The id of the `revision.started` the loop writes when the main agent is told of a go. */
export const goMarkerId = (personMessageEventId: string) => `${personMessageEventId}:go`;

/**
 * Every correction of a run, and the latest if it is not abandoned (`open`). The only place
 * correction state is derived: the thread log, `abandonedEvents`, the runner's `/outputs` backup,
 * and the API's reopen and end of a correction all read it.
 */
export function corrections(events: readonly RunEvent[]): {
  spans: Correction[];
  open: Correction | undefined;
} {
  const spans: Correction[] = [];
  const byReopen = new Map<string, Correction>();
  let root: string | undefined;
  for (const [i, e] of events.entries()) {
    const span = spans.at(-1);
    switch (e.type) {
      case "run.reopened": {
        if (span?.closed === "open") {
          span.closed = "finished";
          span.to = i;
        }
        const next: Correction = {
          reopenId: e.id,
          reopened: i,
          to: events.length,
          closed: "open",
          message: undefined,
          go: undefined,
          backup: "none",
          replied: false,
          claimEnded: false,
        };
        spans.push(next);
        byReopen.set(e.id, next);
        break;
      }
      case "person.message":
        if (span && span.message === undefined) {
          span.message = e.id;
          if (e.payload.go && e.payload.taskId) {
            span.go = { taskId: e.payload.taskId, markerAt: undefined, redone: false };
          }
        }
        break;
      case "reply":
        if (span) span.replied = true;
        break;
      case "thread.started":
        if (e.payload.parentThreadId === null) root = e.threadId;
        break;
      case "thread.ended":
        if (span?.closed === "open" && e.threadId === root && e.payload.status === "completed")
          span.claimEnded = true;
        break;
      case "revision.started":
        if (span?.go && span.message !== undefined && e.id === goMarkerId(span.message)) {
          span.go.markerAt = i;
        }
        break;
      case "attempt.opened":
        if (
          span?.closed === "open" &&
          span.go?.markerAt !== undefined &&
          span.go.taskId === e.payload.taskId
        ) {
          span.go.redone = true;
        }
        break;
      case "correction.ended":
        if (span?.closed === "open") {
          span.closed = "abandoned";
          span.to = i;
        }
        break;
      case "outputs.backed-up":
      case "outputs.restored":
      case "outputs.discarded": {
        const owner = byReopen.get(e.payload.reopenId);
        if (owner) owner.backup = e.type.slice("outputs.".length) as Correction["backup"];
        break;
      }
    }
  }
  const last = spans.at(-1);
  return { spans, open: last?.closed === "open" ? last : undefined };
}

/**
 * The ids of the task-state events inside abandoned corrections (of `events`, or the `spans`
 * given); with `unfinished`, also those of the open correction until its claim ends (review holds
 * a correction back until it finishes, so it shows the last completed revision meanwhile).
 */
export function abandonedEvents(
  events: readonly RunEvent[],
  spans: readonly Correction[] = corrections(events).spans,
  unfinished = false,
): Set<string> {
  const abandoned = new Set<string>();
  for (const span of spans) {
    if (
      !(span.closed === "abandoned" || (unfinished && span.closed === "open" && !span.claimEnded))
    )
      continue;
    for (const e of events.slice(span.reopened, span.to))
      if (TASK_STATE.has(e.type)) abandoned.add(e.id);
  }
  return abandoned;
}

type Skip = { reason: string; revisionId: string; from: string };

type Attempt = {
  id: string | null;
  taskId: string;
  workerThread: string | null;
  checkThread: string | null;
  status: TaskStatus;
  reason: string | null;
  rejected: boolean;
  /** "Marked to check": the event that set it and its reason. */
  flag: { id: string; reason: string } | null;
  resultRevisionId: string;
  milestones: Milestone[];
  toChecks: Check[];
  checker: ReviewTask["checker"];
  outputs: Map<string, OutputEvent>;
  evidence: Map<string, Asset>;
  citedScratch: Set<string>;
};

/** `holdOpenCorrection`: fold as of the last completed revision, skipping a correction still in progress (review). */
export function fold(events: readonly RunEvent[], holdOpenCorrection = false): Folded {
  // Threads that check an attempt: the starts that name one.
  const checkThreads = new Set<string>();
  const threadModel = new Map<string, string>();
  const attempts = new Map<string, Attempt>();
  const current = new Map<string, Attempt>();
  const revisions: FoldedRevision[] = [];
  const assets: Folded["assets"] = {};
  let header: Pick<FoldedRevision, "id" | "createdAt" | "reason" | "taskId"> | undefined;
  // taskId → outputId → declaration, from the run's first event.
  const plan = new Map<string, Map<string, DeclaredOutput>>();
  // output id → the task that declares it; ids are unique in a plan, so links name bare ids.
  const owner = new Map<string, string>();
  // The plan's tasks in order, with every change applied.
  const planTasks = new Map<string, PlanTask>();
  const planNow = (): WorkflowPlan => ({
    tasks: [...planTasks.values()].map((t) => structuredClone(t)),
  });
  // taskId → the `plan.changed.skip` that named it, across revisions.
  const skips = new Map<string, { reason: string; revisionId: string }>();
  // taskId → the attempts its check sent back, oldest first.
  const sentBack = new Map<string, string[]>();
  // taskId → its latest worker thread, whether or not it has opened an attempt yet.
  const workerOf = new Map<string, string>();
  // The run's first revision: where a task with no attempt anchors.
  let runRevisionId = "";
  const setPlanTask = (t: PlanTask) => {
    planTasks.set(t.id, t);
    plan.set(t.id, new Map(t.outputs.map((o) => [o.id, o])));
    for (const o of t.outputs) owner.set(o.id, t.id);
  };
  // The run's first event is `revision.started` (`task-tools.ts`).
  let revisionId = "";

  const addEvidence = (a: Attempt, runId: string, refs: EvidenceRef[]) => {
    for (const r of refs) {
      if (r.root === "scratch") a.citedScratch.add(r.path);
      a.evidence.set(r.sha256, {
        id: r.sha256,
        name: r.path,
        stage: a.taskId,
        key: evidenceKey(runId, r.sha256),
        sha256: r.sha256,
      });
    }
  };

  const snapshot = (): Pick<
    FoldedRevision,
    "tasks" | "volumes" | "structures" | "surfaces" | "annotations"
  > => {
    // The block kind of every output a reference may resolve to, filled as blocks are made.
    const kinds = new Map<string, RefKind>();
    for (const a of current.values())
      for (const [id, v] of a.outputs)
        if (v.payload.output.kind === "measurement") kinds.set(`${a.taskId}/${id}`, "measurement");
    // The one guarantee for references: one that doesn't resolve to an output of
    // an accepted block kind in this revision is dropped (`undefined`).
    const ref = (a: Attempt, id: string | undefined, ...accept: RefKind[]) => {
      if (id === undefined) return undefined;
      const full = id.includes("/") ? id : `${a.taskId}/${id}`;
      const k = kinds.get(full);
      return k && accept.includes(k) ? full : undefined;
    };
    // A declared link: a plan output id to the block it names, when the revision has one.
    const linked = (id: string, ...accept: RefKind[]): string | undefined => {
      const task = owner.get(id);
      const full = `${task}/${id}`;
      const k = kinds.get(full);
      return task !== undefined && k && accept.includes(k) ? full : undefined;
    };
    const shown = (ids: string[]) => ids.flatMap((id) => linked(id, ...BLOCK_KINDS) ?? []);
    // Ids that resolve stay; `label` goes with a `volumeId` that doesn't. A focus
    // left pointing at nothing is absent: the whole task.
    const resolveFocus = (a: Attempt, f: Focus): Focus | undefined => {
      const volumeId = ref(a, f.volumeId, "volume:labels");
      const { volumeId: _v, label, ...rest } = f;
      const resolved = {
        ...rest,
        on: f.on.flatMap((id) => ref(a, id, ...BLOCK_KINDS) ?? []),
        ...(volumeId !== undefined && { volumeId, ...(label !== undefined && { label }) }),
      };
      const points =
        resolved.on.length > 0 || volumeId !== undefined || resolved.box || resolved.point;
      return points ? resolved : undefined;
    };

    // Volumes first: every other block sits on one.
    const volumes: Volume[] = [];
    for (const a of current.values())
      for (const [outputId, { payload: p, runId }] of a.outputs) {
        if (p.output.kind !== "volume") continue;
        const { file, dtype, ...grid } = p.output.volume;
        const id = `${a.taskId}/${outputId}`;
        volumes.push({
          ...grid,
          id,
          name: p.title,
          data: { format: "npy", key: evidenceKey(runId, file.sha256), sha256: file.sha256, dtype },
        });
        kinds.set(id, `volume:${grid.kind}`);
      }
    const volumeById = new Map(volumes.map((v) => [v.id, v]));

    const structures: Structure[] = [];
    const surfaces: Surface[] = [];
    const annotations: Annotation[] = [];
    for (const a of current.values()) {
      for (const [outputId, v] of a.outputs) {
        const { payload: p } = v;
        const { output: o } = p;
        const id = `${a.taskId}/${outputId}`;
        const decl = plan.get(a.taskId)?.get(outputId);
        const gridId =
          decl && fills(decl, o) && "grid" in decl
            ? linked(decl.grid, "volume:image", "volume:labels")
            : undefined;
        const grid = gridId === undefined ? undefined : volumeById.get(gridId);
        const key = (sha: string) => evidenceKey(v.runId, sha);
        switch (o.kind) {
          case "structure": {
            const s = o.structure;
            let voxels: Structure["voxels"] = null;
            if ("label" in s && grid) voxels = { label: s.label };
            else if ("mask" in s && grid)
              voxels = {
                mask: { key: key(s.mask.sha256), sha256: s.mask.sha256, shapeZyx: s.shapeZyx },
                offsetZyx: s.offsetZyx,
              };
            structures.push({
              id,
              name: p.title,
              volumeId: grid?.id ?? null,
              voxels,
              missing: null,
              ...(o.definition !== undefined && { definition: o.definition }),
              ...(o.volumeMm3 !== undefined && { volumeMm3: o.volumeMm3 }),
            });
            kinds.set(id, "structure");
            break;
          }
          case "missing":
            // Of a structure declaration: the object itself shows as missing, with the reason.
            if (decl?.kind !== "structure") break;
            structures.push({
              id,
              name: p.title,
              volumeId: null,
              voxels: null,
              missing: { reason: o.reason },
            });
            kinds.set(id, "structure");
            break;
          case "surface":
            if (!grid) break;
            surfaces.push({
              id,
              name: p.title,
              volumeId: grid.id,
              axis: o.surface.axis,
              heights: { key: key(o.surface.heights.sha256), sha256: o.surface.heights.sha256 },
            });
            kinds.set(id, "surface");
            break;
          case "annotation": {
            if (!grid) break;
            const base = { id, name: p.title, volumeId: grid.id };
            const note = o.note !== undefined ? { note: o.note } : {};
            annotations.push(
              o.annotation.kind === "point"
                ? {
                    ...base,
                    ...note,
                    kind: "point",
                    position: toWorld(grid.affine, o.annotation.zyx),
                  }
                : {
                    ...base,
                    ...note,
                    kind: "line",
                    a: toWorld(grid.affine, o.annotation.aZyx),
                    b: toWorld(grid.affine, o.annotation.bZyx),
                  },
            );
            kinds.set(id, "annotation");
            break;
          }
          default:
            break;
        }
      }
    }

    // Skipped tasks and, in plan order, every task that depends on one, credited to its nearest
    // skipped dependency (first in `dependsOn`). The derived `resultRevisionId` and check ids sit
    // behind stored `check.accepted` events, so this rule must not move.
    const skipped = new Map<string, Skip>();
    const planList = [...planTasks.values()];
    for (const [id, s] of skips) if (planTasks.has(id)) skipped.set(id, { ...s, from: id });
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of planList) {
        const dep = t.dependsOn.find((d) => skipped.has(d));
        const near = dep === undefined ? undefined : skipped.get(dep);
        if (skipped.has(t.id) || !near) continue;
        skipped.set(t.id, {
          reason: `${near.from} was skipped: ${skips.get(near.from)?.reason}`,
          revisionId: near.revisionId,
          from: near.from,
        });
        grew = true;
      }
    }
    const placeholder = (taskId: string): Attempt => ({
      id: null,
      taskId,
      workerThread: workerOf.get(taskId) ?? null,
      checkThread: null,
      status: "pending",
      reason: null,
      rejected: false,
      flag: null,
      resultRevisionId: runRevisionId,
      milestones: [],
      toChecks: [],
      checker: null,
      outputs: new Map(),
      evidence: new Map(),
      citedScratch: new Set(),
    });
    // Plan order; an attempt of a task outside the plan (the tools refuse one) follows.
    const rows = [
      ...planList.map((p) => current.get(p.id) ?? placeholder(p.id)),
      ...[...current.values()].filter((a) => !planTasks.has(a.taskId)),
    ];
    const tasks = rows.map((a) => {
      const skip = skipped.get(a.taskId);
      const measurements: Measurement[] = [];
      const scores: Score[] = [];
      const files: Asset[] = [];
      const undeclared: string[] = [];
      // A task with no attempt has reported nothing and owes nothing yet (a skipped one is owed
      // its missing outputs, with the reason).
      const owed = a.id !== null || skip !== undefined;
      const declaredOutputs = owed ? [...(plan.get(a.taskId)?.values() ?? [])] : [];
      for (const [outputId, v] of a.outputs) {
        const { payload: p } = v;
        const { output: o } = p;
        const id = `${a.taskId}/${outputId}`;
        const decl = plan.get(a.taskId)?.get(outputId);
        if (!(decl !== undefined && fills(decl, o))) undeclared.push(id);
        const evidenceIds = p.evidence.map((r) => r.sha256);
        const source = { threadId: v.threadId, eventId: v.id };
        const on = shown(decl && "on" in decl ? decl.on : []);
        const context = shown(decl && "context" in decl ? (decl.context ?? []) : []);
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
              on,
              context,
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
              on,
              context,
              source,
            });
            break;
          case "file":
            files.push({
              id,
              name: p.title,
              stage: a.taskId,
              key: evidenceKey(v.runId, o.file.sha256),
              sha256: o.file.sha256,
              mediaType: o.mediaType,
            });
            break;
          default:
            break;
        }
      }
      // Declared outputs with no result: not reported, or reported `missing`. A `missing` report
      // and a skip account for the output, so neither counts toward `missingRequired`.
      const reportedOf = (d: DeclaredOutput) => {
        const o = a.outputs.get(d.id)?.payload.output;
        return o && fills(d, o) ? o : undefined;
      };
      const reasonOf = (d: DeclaredOutput) => {
        const o = reportedOf(d);
        return o?.kind === "missing" ? o.reason : skip?.reason;
      };
      const missing = declaredOutputs
        .filter((d) => {
          const o = reportedOf(d);
          return !o || (o.kind === "missing" && d.kind !== "structure");
        })
        .map((d) => ({
          outputId: d.id,
          kind: d.kind,
          required: d.required,
          ...(reasonOf(d) !== undefined && { reason: reasonOf(d) }),
        }));
      const missingRequired = skip
        ? []
        : declaredOutputs.filter((d) => d.required && !reportedOf(d)).map((d) => d.id);
      const checks: Check[] = a.toChecks.map(({ focus, ...c }) => {
        const f = focus && resolveFocus(a, focus);
        return { ...c, ...(f && { focus: f }) };
      });
      if (skip)
        checks.push({
          id: `${a.taskId}/skipped`,
          title: "Skipped",
          detail: skip.reason,
          status: "open",
        });
      else if (a.flag)
        checks.push({
          id: a.flag.id,
          title: "Marked to check",
          detail: a.flag.reason,
          status: "open",
        });
      const planned = planTasks.get(a.taskId);
      const row = {
        id: a.taskId,
        title: planned?.title ?? a.taskId,
        ask: planned?.instructions ?? "",
        attemptId: a.id,
        status: skip ? "to-check" : a.status,
        reason: skip ? skip.reason : a.reason,
        ...(skip && { skipped: { reason: skip.reason, from: skip.from } }),
        sentBack: [...(sentBack.get(a.taskId) ?? [])],
        rejected: !skip && a.rejected,
        resultRevisionId: skip ? skip.revisionId : a.resultRevisionId,
        checker: a.checker && { ...a.checker },
        threads: { worker: a.workerThread, check: a.checkThread },
        models: {
          worker: a.workerThread ? (threadModel.get(a.workerThread) ?? null) : null,
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
        citedScratch: [...a.citedScratch],
      };
      return { ...row, satisfied: isSatisfied(row) };
    });
    return { tasks, volumes, structures, surfaces, annotations };
  };

  const abandoned = abandonedEvents(events, undefined, holdOpenCorrection);
  for (const e of events) {
    if (abandoned.has(e.id)) continue;
    switch (e.type) {
      case "thread.started": {
        if (e.payload.attemptId) checkThreads.add(e.threadId);
        else if (e.payload.task) workerOf.set(e.payload.task, e.threadId);
        if (e.payload.model) threadModel.set(e.threadId, e.payload.model);
        const checked = e.payload.attemptId && attempts.get(e.payload.attemptId);
        // A resume re-emits `thread.started` for the same thread: only a new check thread resets the verdict.
        if (checked && checked.checkThread !== e.threadId) {
          checked.checkThread = e.threadId;
          checked.checker = null; // the verdict shown is this check's
        }
        break;
      }
      case "revision.started": {
        if (header) revisions.push({ ...header, ...snapshot(), plan: planNow() });
        revisionId = e.id;
        const { payload: p } = e;
        if (p.reason === "run") {
          runRevisionId = e.id;
          for (const t of p.plan.tasks) setPlanTask(structuredClone(t));
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
          rejected: false,
          flag: null,
          resultRevisionId: revisionId,
          milestones: [],
          toChecks: [],
          checker: null,
          outputs: new Map(),
          evidence: new Map(),
          citedScratch: new Set(),
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
        a.rejected =
          status === "to-check" &&
          by.kind === "rule" &&
          by.rule === "check-result" &&
          a.checker?.verdict === "needs-review";
        if (a.rejected) {
          const sent = sentBack.get(a.taskId) ?? [];
          if (!sent.includes(e.payload.attemptId))
            sentBack.set(a.taskId, [...sent, e.payload.attemptId]);
        }
        if (status === "to-check") {
          if (!(by.kind === "rule" && by.rule === "check-result")) a.flag = { id: e.id, reason };
        } else if (status !== "under-review") a.flag = null;
        a.resultRevisionId = revisionId;
        break;
      }
      case "checkpoint": {
        const a = attempts.get(e.payload.attemptId);
        if (!a) break;
        const { text, summary, verdict, toCheck, evidence } = e.payload;
        const byCheck = checkThreads.has(e.threadId);
        addEvidence(a, e.runId, evidence);
        a.milestones.push({
          id: e.id,
          threadId: e.threadId,
          text,
          ...(summary && { summary }),
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
        // The output's own files are the checker's to inspect, though they are not evidence.
        for (const r of fileRefsOf(e.payload.output))
          if (r.root === "scratch") a.citedScratch.add(r.path);
        a.outputs.set(e.payload.outputId, e);
        a.resultRevisionId = revisionId;
        break;
      }
      case "plan.changed": {
        const { add, adHoc, doneWhen, instructions, skip } = e.payload;
        // An id already in the plan keeps its entry: a collision must not replace a task's outputs.
        for (const t of add ?? []) if (!planTasks.has(t.id)) setPlanTask(structuredClone(t));
        for (const t of adHoc ?? [])
          if (!planTasks.has(t.id))
            setPlanTask({
              id: t.id,
              title: t.title,
              dependsOn: t.dependsOn,
              instructions: t.instructions,
              outputs: [],
            });
        for (const d of doneWhen ?? []) {
          const t = planTasks.get(d.taskId);
          if (t) t.doneWhen = [...(t.doneWhen ?? []), ...d.lines];
        }
        for (const i of instructions ?? []) {
          const t = planTasks.get(i.taskId);
          if (t) t.instructions = t.instructions ? `${t.instructions}\n\n${i.text}` : i.text;
        }
        for (const s of skip ?? [])
          if (!skips.has(s.taskId)) skips.set(s.taskId, { reason: s.reason, revisionId });
        break;
      }
      case "assets.ready": {
        const { sourceSha256, ...manifest } = e.payload;
        assets[sourceSha256] = { state: "ready", ...manifest };
        break;
      }
      case "assets.failed":
        assets[e.payload.sourceSha256] = { state: "failed", error: e.payload.error };
        break;
      default:
        break;
    }
  }

  const last = snapshot();
  const planEnd = planNow();
  if (header) revisions.push({ ...header, ...last, plan: planEnd });
  return { tasks: last.tasks, plan: planEnd, revisions, assets };
}
