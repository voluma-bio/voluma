/**
 * A run's review data (`@voluma/contracts/review`) from its recorded plan, overlaid with
 * `fold`'s attempts and blocks. Planned tasks without an attempt remain visible as pending.
 * Pure, so the route only loads and serves.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { FoldedRevision, FoldedTask } from "@voluma/contracts/fold";
import type { ReviewRun, ReviewTask } from "@voluma/contracts/review";
import type { RunRecord } from "../../ports";

/** Null until the run's first `revision.started`: a run with no plan has nothing to review. */
export function reviewRun({
  run,
  events,
  results: { revisions, assets },
}: Pick<RunRecord, "run" | "events" | "results">): ReviewRun | null {
  // Not `events[0]`: the root's `thread.started` comes first.
  const start = events.find((e) => e.type === "revision.started" && e.payload.reason === "run");
  if (start?.type !== "revision.started" || start.payload.reason !== "run") return null;
  // Each revision's plan is the fold's: the run's plus every `plan.changed` so far, so added tasks show.
  const plannedIn = (rev: FoldedRevision) => new Map(rev.plan.tasks.map((t) => [t.id, t]));

  const task = (t: FoldedTask, planned: ReturnType<typeof plannedIn>): ReviewTask => {
    const title = planned.get(t.id)?.title ?? t.id;
    const staged = <A extends { stage: string }>(assets: A[]) =>
      assets.map((a) => ({ ...a, stage: title }));
    return {
      id: t.id,
      title,
      ask: planned.get(t.id)?.instructions ?? "",
      dependsOn: t.dependsOn,
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
      return `Correction: ${plannedIn(rev).get(id)?.title ?? id}`;
    }
    throw new Error("Unsupported revision reason");
  };

  const workers = new Map<string, Extract<RunEvent, { type: "thread.started" }>>();
  let cursor = 0;
  return {
    id: run.id,
    sample: run.input.name,
    workflows: run.workflows,
    review: run.review,
    assets,
    revisions: revisions.map((rev, index) => {
      // Thread starts can precede the first task-tool write (and hence the attempt).
      // Stop at this snapshot's boundary so later starts never change an earlier revision.
      const nextRevisionId = revisions[index + 1]?.id;
      while (events[cursor] && events[cursor]?.id !== nextRevisionId) {
        const event = events[cursor++];
        if (event?.type === "thread.started" && event.payload.task && !event.payload.attemptId)
          workers.set(event.payload.task, event);
      }
      const planned = plannedIn(rev);
      const attempted = new Map(rev.tasks.map((t) => [t.id, t]));
      return {
        id: rev.id,
        label: label(rev),
        createdAt: rev.createdAt,
        tasks: rev.plan.tasks.map((p): ReviewTask => {
          const t = attempted.get(p.id);
          if (t) return { ...task(t, planned), dependsOn: p.dependsOn };
          const worker = workers.get(p.id);
          return {
            id: p.id,
            title: p.title ?? p.id,
            ask: p.instructions ?? "",
            dependsOn: p.dependsOn,
            status: "pending",
            // There is no result yet; the required revision reference anchors the planned row.
            resultRevisionId: start.id,
            checker: null,
            threads: { worker: worker?.threadId ?? null, check: null },
            models: { worker: worker?.payload.model ?? null, check: null },
            measurements: [],
            scores: [],
            missing: [],
            undeclared: [],
            checks: [],
            evidence: [],
            files: [],
          };
        }),
        volumes: rev.volumes,
        structures: rev.structures,
        surfaces: rev.surfaces,
        annotations: rev.annotations,
      };
    }),
  };
}
