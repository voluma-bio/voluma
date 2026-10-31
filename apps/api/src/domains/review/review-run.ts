/**
 * A run's review data (`@voluma/contracts/review`) from `fold`'s revisions: each holds a row
 * per planned task, `pending` where nothing started. Pure, so the route only loads and serves.
 */
import type { FoldedRevision, FoldedTask } from "@voluma/contracts/fold";
import type { ReviewRun, ReviewTask } from "@voluma/contracts/review";
import type { RunRecord } from "../../ports";

/** Null until the run's first `revision.started`: a run with no plan has nothing to review. */
export function reviewRun({
  run,
  results: { revisions, assets },
}: Pick<RunRecord, "run" | "results">): ReviewRun | null {
  if (revisions.length === 0) return null;

  const task = (t: FoldedTask, dependsOn: string[]): ReviewTask => {
    const staged = <A extends { stage: string }>(assets: A[]) =>
      assets.map((a) => ({ ...a, stage: t.title }));
    return {
      id: t.id,
      title: t.title,
      dependsOn,
      status: t.status,
      resultRevisionId: t.resultRevisionId,
      checker: t.checker,
      threads: t.threads,
      models: t.models,
      measurements: t.measurements,
      scores: t.scores,
      missing: t.missing,
      undeclared: t.undeclared,
      checks: t.checks,
      evidence: staged(t.evidence),
      files: staged(t.files),
    };
  };

  const label = (rev: FoldedRevision) => {
    if (rev.reason === "run") return "Run";
    if (rev.reason === "correction") {
      const id = rev.taskId ?? "";
      return `Correction: ${rev.tasks.find((t) => t.id === id)?.title ?? id}`;
    }
    throw new Error("Unsupported revision reason");
  };

  return {
    id: run.id,
    sample: run.input.name,
    workflows: run.workflows,
    review: run.review,
    assets,
    revisions: revisions.map((rev) => {
      const planned = new Map(rev.plan.tasks.map((p) => [p.id, p]));
      return {
        id: rev.id,
        label: label(rev),
        createdAt: rev.createdAt,
        tasks: rev.tasks.map((t) => task(t, planned.get(t.id)?.dependsOn ?? [])),
        volumes: rev.volumes,
        structures: rev.structures,
        surfaces: rev.surfaces,
        annotations: rev.annotations,
      };
    }),
  };
}
