/**
 * A run's review data (`@voluma/contracts/review`) from its recorded plan, overlaid with
 * `fold`'s attempts and blocks. Planned tasks without an attempt remain visible as pending.
 * Pure, so the route only loads and serves.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { FoldedRevision, FoldedTask } from "@voluma/contracts/fold";
import { type ReviewRun, type ReviewTask, reviewRunSchema } from "@voluma/contracts/review";
import type { RunRecord } from "../../ports";

/** Null until the run's first `revision.started`: a run with no plan has nothing to review. */
export function reviewRun({
  run,
  events,
  results: { revisions, assets },
}: RunRecord): ReviewRun | null {
  // Not `events[0]`: the supervisor's `thread.started` and the run-start `wake` come first.
  const start = events.find((e) => e.type === "revision.started" && e.payload.reason === "run");
  if (start?.type !== "revision.started" || start.payload.reason !== "run") return null;
  const plan = start.payload.plan.tasks;
  const planned = new Map(plan.map((t) => [t.id, t]));
  const titleOf = (taskId: string) => planned.get(taskId)?.title ?? taskId;

  const task = (t: FoldedTask, rev: FoldedRevision): ReviewTask => {
    const title = titleOf(t.id);
    const staged = <A extends { stage: string }>(assets: A[]) =>
      assets.map((a) => ({ ...a, stage: title }));
    // The structures it reported, and those its numbers were measured on.
    const structures = new Set(rev.structures.map((s) => s.id));
    const own = [...structures].filter((id) => id.startsWith(`${t.id}/`));
    const cited = [...t.measurements, ...t.scores].flatMap((m) =>
      m.on.filter((id) => structures.has(id)),
    );
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
    if (rev.reason === "correction") return `Correction: ${titleOf(rev.taskId ?? "")}`;
    throw new Error("Unsupported revision reason");
  };

  const workers = new Map<string, Extract<RunEvent, { type: "thread.started" }>>();
  let cursor = 0;
  return reviewRunSchema.parse({
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
        if (
          event?.type === "thread.started" &&
          event.payload.kind === "worker" &&
          event.payload.task
        )
          workers.set(event.payload.task, event);
      }
      const attempted = new Map(rev.tasks.map((t) => [t.id, t]));
      return {
        id: rev.id,
        label: label(rev),
        createdAt: rev.createdAt,
        tasks: plan.map((p): ReviewTask => {
          const t = attempted.get(p.id);
          if (t) return { ...task(t, rev), dependsOn: p.dependsOn };
          const worker = workers.get(p.id);
          return {
            id: p.id,
            title: titleOf(p.id),
            ask: p.instructions ?? "",
            dependsOn: p.dependsOn,
            status: "pending",
            // There is no result yet; the required revision reference anchors the planned row.
            resultRevisionId: start.id,
            checker: null,
            threads: { worker: worker?.threadId ?? null, check: null, chat: null },
            models: { worker: worker?.payload.model ?? null, check: null, chat: null },
            structureIds: [],
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
  });
}
