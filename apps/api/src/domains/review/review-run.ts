/**
 * A run's review data (`@voluma/contracts/review`) from its event log: `fold` decides the
 * tasks and blocks; this adds what the events don't carry (`fold.ts`'s header lists it).
 * Pure, so the route only loads and serves.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { type FoldedRevision, type FoldedTask, fold } from "@voluma/contracts/fold";
import {
  type Annotation,
  type Focus,
  type ReviewRun,
  type ReviewTask,
  reviewRunSchema,
} from "@voluma/contracts/review";
import type { Run } from "@voluma/contracts/run";
import type { WorkflowPlan } from "@voluma/contracts/workflow";

/** Null until the run's first `revision.started`: a run with no plan has nothing to review. */
export function reviewRun(run: Run, events: readonly RunEvent[]): ReviewRun | null {
  const { revisions } = fold(events);
  if (revisions.length === 0) return null;
  // Not `events[0]`: the supervisor's `thread.started` and the run-start `wake` come first.
  const start = events.find((e) => e.type === "revision.started");
  const plan: WorkflowPlan["tasks"] =
    start?.type === "revision.started" && start.payload.reason === "run"
      ? start.payload.plan.tasks
      : [];
  const planned = new Map(plan.map((t) => [t.id, t]));
  // TODO(.context/TODO.md): the plan's task `title` once it lands (#86).
  const titleOf = (taskId: string) => taskId;

  // TODO(.context/TODO.md): an annotation on the scan (`volumeId` null) needs the scan's
  // volume, whose geometry the API doesn't read yet; until then it and every reference to
  // it are left out.
  const task = (t: FoldedTask, rev: FoldedRevision, onScan: Set<string>): ReviewTask => {
    const title = titleOf(t.id);
    const staged = <A extends { stage: string }>(assets: A[]) =>
      assets.map((a) => ({ ...a, stage: title }));
    const kept = <X extends { annotationIds: string[] }>(x: X) => ({
      ...x,
      annotationIds: x.annotationIds.filter((id) => !onScan.has(id)),
    });
    // As `fold` does: a focus left pointing at nothing is absent, which means the whole task.
    const focused = (f: Focus): Focus | undefined => {
      const k = kept(f);
      return k.structureIds.length + k.annotationIds.length > 0 || k.volumeId || k.box || k.point
        ? k
        : undefined;
    };
    // The structures it reported, and those its numbers were counted from.
    const own = rev.structures.filter((s) => s.id.startsWith(`${t.id}/`)).map((s) => s.id);
    const cited = [...t.measurements, ...t.scores].flatMap((m) => m.structureIds);
    return {
      id: t.id,
      title,
      ask: planned.get(t.id)?.instructions ?? "",
      dependsOn: t.dependsOn,
      structureIds: [...new Set([...own, ...cited])],
      status: t.status,
      resultRevisionId: t.resultRevisionId,
      checker: t.checker,
      // No review chat yet: it is one thread per run, and its contract is still to come.
      threads: { ...t.threads, chat: null },
      models: { ...t.models, chat: null },
      measurements: t.measurements.map(kept),
      scores: t.scores.map(kept),
      missing: t.missing,
      undeclared: t.undeclared,
      checks: t.checks.map(({ focus, ...c }) => {
        const f = focus && focused(focus);
        return f ? { ...c, focus: f } : c;
      }),
      evidence: staged(t.evidence),
      files: staged(t.files),
    };
  };

  const label = (rev: FoldedRevision) =>
    rev.reason === "run"
      ? "Run"
      : `${rev.reason === "correction" ? "Correction" : "Check fix"}: ${titleOf(rev.taskId ?? "")}`;

  return reviewRunSchema.parse({
    id: run.id,
    sample: run.input.name,
    workflows: run.workflows,
    revisions: revisions.map((rev) => {
      const onScan = new Set(rev.annotations.filter((a) => a.volumeId === null).map((a) => a.id));
      return {
        id: rev.id,
        label: label(rev),
        createdAt: rev.createdAt,
        tasks: rev.tasks.map((t) => task(t, rev, onScan)),
        volumes: rev.volumes,
        structures: rev.structures,
        annotations: rev.annotations.filter((a): a is Annotation => a.volumeId !== null),
      };
    }),
  });
}
