/**
 * Shared by the fold tests: a log builder, and the check that every folded revision is a valid
 * `ReviewRun` once the parts the API adds are filled in. Valid means the schema's shape plus
 * `reviewIntegrityIssues`: the fold guarantees these, so nothing checks them at runtime.
 */
import { expect } from "vitest";
import type { RunEvent } from "./events";
import { checkResult, type Folded, type FoldedRevision, fold } from "./fold";
import type { Output } from "./output";
import { imageDtype, labelDtype, type ReviewRun, reviewRunSchema } from "./review";
import type { WorkflowPlan } from "./workflow";

export type Payload<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>["payload"];

export const RUN = "run1";
export const SHA = (n: number) => n.toString(16).padStart(64, "0");

/** A log under construction; `seq` and `createdAt` follow append order. */
export function log() {
  const events: RunEvent[] = [];
  const add = <T extends RunEvent["type"]>(
    type: T,
    id: string,
    threadId: string,
    payload: Payload<T>,
  ) => {
    const seq = events.length;
    events.push({
      id,
      runId: RUN,
      threadId,
      createdAt: new Date(Date.UTC(2026, 9, 28, 0, 0, seq)).toISOString(),
      seq,
      type,
      payload,
    } as RunEvent);
  };
  const by = { kind: "agent" } as const;
  const reportOutput = (
    id: string,
    thread: string,
    taskId: string,
    attemptId: string,
    outputId: string,
    output: Output,
    extra: Partial<Payload<"output">> = {},
  ) =>
    add("output", id, thread, {
      taskId,
      attemptId,
      outputId,
      title: outputId,
      evidence: [],
      output,
      ...extra,
    });
  const rule = (r: "stuck" | "stale" | "check-start" | "check-result") =>
    ({ kind: "rule", rule: r }) as const;
  return {
    events,
    add,
    revision: (id: string, thread: string, p: Payload<"revision.started">) =>
      add("revision.started", id, thread, p),
    /** The run's first event, with the plan the runtime copied from the workflow. */
    run: (plan: WorkflowPlan = { tasks: [] }) =>
      add("revision.started", "root:revision", "root", { reason: "run", plan }),
    thread: (thread: string, kind: "worker" | "check" | "supervisor", attemptId?: string) =>
      add("thread.started", `${thread}:started`, thread, {
        name: thread,
        parentThreadId: kind === "supervisor" ? null : "root",
        workflows: [{ repo: "o/w", commit: "a".repeat(40) }],
        kind,
        ...(attemptId && { attemptId }),
      }),
    open: (id: string, thread: string, taskId: string) =>
      add("attempt.opened", id, thread, { taskId }),
    status: (
      id: string,
      thread: string,
      taskId: string,
      attemptId: string,
      status: Payload<"task">["status"],
      who: Payload<"task">["by"] = by,
    ) =>
      add("task", id, thread, { taskId, attemptId, status, reason: `${status} (${id})`, by: who }),
    checkpoint: (
      id: string,
      thread: string,
      taskId: string,
      attemptId: string,
      extra: Partial<Payload<"checkpoint">> = {},
    ) =>
      add("checkpoint", id, thread, {
        taskId,
        attemptId,
        text: `milestone ${id}`,
        by,
        evidence: [],
        ...extra,
      }),
    /** A `measurement` output (`value` in mm unless `extra` says otherwise). */
    measurement: (
      id: string,
      thread: string,
      taskId: string,
      attemptId: string,
      outputId: string,
      value: number | null,
      {
        evidence = [],
        ...extra
      }: Partial<Extract<Output, { kind: "measurement" }>> & {
        evidence?: Payload<"output">["evidence"];
      } = {},
    ) =>
      reportOutput(
        id,
        thread,
        taskId,
        attemptId,
        outputId,
        {
          kind: "measurement",
          value,
          unit: "mm",
          confidence: null,
          ...extra,
        },
        { evidence },
      ),
    output: reportOutput,
    rule,
    /** The runtime's `check-result`: the status `checkResult` gives the folded task. */
    result: (thread: string, taskId: string, attemptId: string) => {
      const t = need(fold(events), taskId);
      add("task", `${thread}:result`, thread, {
        taskId,
        attemptId,
        status: checkResult(t),
        reason: "check result",
        by: rule("check-result"),
      });
    },
  };
}

export const need = <T extends { id: string }>(x: { tasks: T[] } | T[], id: string): T => {
  const t = (Array.isArray(x) ? x : x.tasks).find((t) => t.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};
export const rev = (f: Folded, n: number): FoldedRevision => {
  const r = f.revisions[n];
  if (!r) throw new Error(`no revision ${n}`);
  return r;
};

/** Every revision, with the parts the API adds, must be a valid `ReviewRun`. */
export function expectParses(f: Folded) {
  const run = {
    id: RUN,
    sample: "s",
    workflows: [{ repo: "o/w", commit: "a".repeat(40) }],
    review: null,
    assets: f.assets,
    revisions: f.revisions.map((r) => ({
      id: r.id,
      label: r.reason,
      createdAt: r.createdAt,
      volumes: r.volumes,
      structures: r.structures,
      surfaces: r.surfaces,
      annotations: r.annotations,
      tasks: r.tasks.map((t) => ({
        ...t,
        dependsOn: r.plan.tasks.find((p) => p.id === t.id)?.dependsOn ?? [],
        threads: t.threads,
        models: t.models,
      })),
    })),
  };
  expect(reviewRunSchema.safeParse(run).error).toBeUndefined();
  expect(reviewIntegrityIssues(run)).toEqual([]);
}

/** Duplicate ids and references to ids that don't exist, across a `ReviewRun`; empty when it holds together. */
export function reviewIntegrityIssues(run: ReviewRun): string[] {
  const issues: string[] = [];
  const bad = (message: string) => issues.push(message);
  const idsOf = (xs: { id: string }[], block: string) => {
    const seen = new Set<string>();
    for (const x of xs) {
      if (seen.has(x.id)) bad(`${block}: duplicate id "${x.id}"`);
      seen.add(x.id);
    }
    return seen;
  };
  // Each id in `ids` (optional ones may be undefined) must be in `known`.
  const needAll = (
    known: Set<string>,
    ids: (string | undefined)[],
    where: string,
    what: string,
  ) => {
    for (const id of ids)
      if (id !== undefined && !known.has(id)) bad(`${where}: unknown ${what} "${id}"`);
  };

  const revisionIds = idsOf(run.revisions, "revisions");
  for (const rev of run.revisions) {
    const volumes = idsOf(rev.volumes, "volumes");
    const structures = idsOf(rev.structures, "structures");
    const surfaces = idsOf(rev.surfaces, "surfaces");
    const annotations = idsOf(rev.annotations, "annotations");
    const tasks = idsOf(rev.tasks, "tasks");
    const measurements = idsOf(
      rev.tasks.flatMap((t) => t.measurements),
      "measurements",
    );
    idsOf(
      rev.tasks.flatMap((t) => t.scores),
      "scores",
    );
    const kindOf = new Map(rev.volumes.map((v) => [v.id, v.kind]));

    for (const v of rev.volumes) {
      if (v.data?.format !== "npy") continue;
      const ok = v.kind === "image" ? imageDtype : labelDtype;
      if (!ok.safeParse(v.data.dtype).success)
        bad(`volume ${v.id}: ${v.data.dtype} is not allowed for a ${v.kind} volume`);
    }
    // Every block on a grid names that volume.
    for (const [block, xs] of [
      ["structure", rev.structures],
      ["surface", rev.surfaces],
      ["annotation", rev.annotations],
    ] as const) {
      for (const x of xs) needAll(volumes, [x.volumeId ?? undefined], `${block} ${x.id}`, "volume");
    }
    for (const x of rev.structures) {
      if (
        x.voxels &&
        "label" in x.voxels &&
        x.volumeId !== null &&
        kindOf.get(x.volumeId) === "image"
      )
        bad(`structure ${x.id}: volume "${x.volumeId}" is not a labels volume`);
    }
    // What a measurement can be shown with.
    const shown = new Set([...volumes, ...structures, ...surfaces, ...annotations]);
    for (const t of rev.tasks) {
      idsOf(t.evidence, "evidence");
      needAll(tasks, t.dependsOn, `task ${t.id}`, "task");
      const own = new Set(t.evidence.map((e) => e.id));
      for (const sc of t.scores) {
        needAll(shown, [...sc.on, ...sc.context], `score ${sc.id}`, "block");
        needAll(own, sc.evidenceIds, `score ${sc.id}`, "evidence in this task");
      }
      for (const c of t.checks) {
        const f = c.focus;
        if (!f) continue;
        needAll(shown, f.on, `check ${c.id}`, "block");
        needAll(volumes, [f.volumeId], `check ${c.id}`, "volume");
        if (
          f.volumeId !== undefined &&
          kindOf.has(f.volumeId) &&
          kindOf.get(f.volumeId) !== "labels"
        )
          bad(`check ${c.id}: volume "${f.volumeId}" is not a labels volume`);
      }
      for (const m of t.measurements) {
        needAll(shown, [...m.on, ...m.context], `measurement ${m.id}`, "block");
        needAll(own, m.evidenceIds, `measurement ${m.id}`, "evidence in this task");
        needAll(
          measurements,
          [m.numeratorId, m.denominatorId],
          `measurement ${m.id}`,
          "measurement",
        );
      }
      if (!revisionIds.has(t.resultRevisionId))
        bad(`task ${t.id}: unknown revision "${t.resultRevisionId}"`);
    }
  }

  return issues;
}

export const W = "worker";
export const SUP = "sup";

/** Tasks a and b finished by the worker, in one revision. */
export function twoDone() {
  const l = log();
  l.run();
  l.open("w:1:open", W, "a");
  l.status("w:1", W, "a", "w:1:open", "in-progress");
  l.measurement("w:2", W, "a", "w:1:open", "width", 3.4, {
    evidence: [{ root: "outputs", path: "a.png", sha256: SHA(1) }],
  });
  l.status("w:3", W, "a", "w:1:open", "done");
  l.open("w:4:open", W, "b");
  l.measurement("w:5", W, "b", "w:4:open", "width", 5);
  l.status("w:6", W, "b", "w:4:open", "done");
  return l;
}
