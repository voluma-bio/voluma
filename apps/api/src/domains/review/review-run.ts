/**
 * A run's review data (`@voluma/contracts/review`) from its recorded plan, overlaid with
 * `fold`'s attempts and blocks. Planned tasks without an attempt remain visible as pending.
 * Pure, so the route only loads and serves.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { FoldedRevision, FoldedTask } from "@voluma/contracts/fold";
import {
  type Annotation,
  type Focus,
  type ReviewRun,
  type ReviewTask,
  reviewRunSchema,
} from "@voluma/contracts/review";
import type { RunRecord } from "../../ports";

/** Null until the run's first `revision.started`: a run with no plan has nothing to review. */
export function reviewRun({
  run,
  events,
  results: { revisions },
}: Pick<RunRecord, "run" | "events" | "results">): ReviewRun | null {
  // Not `events[0]`: the supervisor's `thread.started` and the run-start `wake` come first.
  const start = events.find((e) => e.type === "revision.started" && e.payload.reason === "run");
  if (start?.type !== "revision.started" || start.payload.reason !== "run") return null;
  const plan = start.payload.plan.tasks;
  const planned = new Map(plan.map((t) => [t.id, t]));
  const titleOf = (taskId: string) => planned.get(taskId)?.title ?? taskId;

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
      const onScan = new Set(rev.annotations.filter((a) => a.volumeId === null).map((a) => a.id));
      return {
        id: rev.id,
        label: label(rev),
        createdAt: rev.createdAt,
        tasks: plan.map((p): ReviewTask => {
          const t = attempted.get(p.id);
          if (t) return { ...task(t, rev, onScan), dependsOn: p.dependsOn };
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
        annotations: rev.annotations.filter((a): a is Annotation => a.volumeId !== null),
      };
    }),
  });
}
