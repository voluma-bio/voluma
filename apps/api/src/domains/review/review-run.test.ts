/** Review projection regressions: the recorded plan survives missing attempts and later revisions. */
import { type RunEvent, runEventSchema } from "@voluma/contracts/events";
import { reviewRunSchema } from "@voluma/contracts/review";
import { reviewState } from "@voluma/contracts/review-state";
import type { Run } from "@voluma/contracts/run";
import type { WorkflowPlan } from "@voluma/contracts/workflow";
import { workflowFilesSchema } from "@voluma/contracts/workflow-files";
import { computePlan } from "@voluma/workflow/plan";
import { describe, expect, it } from "vitest";
import outputs from "../../../../../workflows/mouse-oa/outputs.json";
import tasks from "../../../../../workflows/mouse-oa/tasks.json";
import { reviewRun } from "./review-run";

const at = "2026-10-28T00:00:00.000Z";
const workflows = [{ repo: "voluma-bio/voluma", commit: "a".repeat(40) }];
const run: Run = {
  id: "review-111",
  labId: "review-tests",
  startedBy: "review-tests",
  studyId: "review-study",
  workflows,
  input: {
    id: "reference-review-tests",
    labId: "review-tests",
    uploadedBy: "voluma-examples",
    source: "reference",
    name: "OA6-1RK (mouse knee)",
  },
  credentials: "voluma",
  example: false,
  tasks: null,
  createdAt: at,
  state: { status: "ended", outcome: "failed", startedAt: at, endedAt: at },
  usage: { modelCostUsd: 0, sandboxSeconds: 0 },
  providerCalls: { costUsd: 0, calls: 0, unknownCostCalls: 0, bySandbox: [] },
  review: null,
};
const plan = computePlan(workflowFilesSchema.parse({ outputs, tasks }));

function log() {
  const events: RunEvent[] = [];
  const add = (type: RunEvent["type"], payload: unknown, threadId = "review-111.supervisor") => {
    const id = `event-${events.length}`;
    events.push(
      runEventSchema.parse({
        id,
        runId: run.id,
        threadId,
        seq: events.length,
        createdAt: at,
        type,
        payload,
      }),
    );
    return id;
  };
  const worker = (task: string, threadId: string) =>
    add(
      "thread.started",
      {
        name: threadId.replace("review-111.", ""),
        parentThreadId: "review-111.supervisor",
        kind: "worker",
        task,
        model: "meta/muse-spark-1.3",
      },
      threadId,
    );
  const open = (taskId: string, threadId: string) => add("attempt.opened", { taskId }, threadId);
  const status = (taskId: string, attemptId: string, value: string, threadId: string) =>
    add(
      "task",
      { taskId, attemptId, status: value, reason: "Provider unavailable", by: { kind: "agent" } },
      threadId,
    );
  return { events, add, worker, open, status };
}

describe("reviewRun", () => {
  it("keeps all eight planned tasks when intake fails and the other seven never start", () => {
    const l = log();
    const initial = l.add("revision.started", { reason: "run", plan });
    l.worker("intake", "review-111.intake.worker");
    const attempt = l.open("intake", "review-111.intake.worker");
    l.status("intake", attempt, "failed", "review-111.intake.worker");

    const result = reviewRun({ run, results: reviewState(l.events) });
    expect(result?.revisions[0]?.tasks.map((t) => [t.id, t.status])).toEqual([
      ["intake", "failed"],
      ["segmentation", "pending"],
      ["iioc", "pending"],
      ["subchondral-plate", "pending"],
      ["trabecular-roi", "pending"],
      ["metaphyseal-roi", "pending"],
      ["cortical", "pending"],
      ["femoral-geometry", "pending"],
    ]);
    const pending = result?.revisions[0]?.tasks.find((t) => t.id === "segmentation");
    expect(pending).toMatchObject({
      dependsOn: ["intake"],
      resultRevisionId: initial,
      checker: null,
      threads: { worker: null, check: null },
      models: { worker: null, check: null },
      measurements: [],
      scores: [],
      missing: [],
      undeclared: [],
      checks: [],
      evidence: [],
      files: [],
    });
    expect(result?.revisions[0]?.structures).toEqual([]);
    expect(reviewRunSchema.safeParse(result).success).toBe(true);
  });

  it("uses only the recorded plan, even before any attempt", () => {
    const l = log();
    const selected: WorkflowPlan = {
      tasks: plan.tasks.filter((t) => t.id === "intake" || t.id === "segmentation"),
    };
    // A root invocation can precede the initial revision.
    l.add("thread.started", {
      name: "supervisor",
      parentThreadId: null,
      kind: "supervisor",
      workflows,
    });
    l.add("revision.started", { reason: "run", plan: selected });
    expect(
      reviewRun({ run, results: reviewState(l.events) })?.revisions[0]?.tasks.map((t) => [
        t.id,
        t.status,
      ]),
    ).toEqual([
      ["intake", "pending"],
      ["segmentation", "pending"],
    ]);
  });

  it("distinguishes a worker start without an attempt at each revision cutoff and preserves retries", () => {
    const l = log();
    const initial = l.add("revision.started", { reason: "run", plan });
    l.add("revision.started", { reason: "correction", taskId: "intake" });
    l.worker("segmentation", "review-111.segmentation.worker");
    l.add(
      "thread.ended",
      { status: "failed", error: "Provider unavailable" },
      "review-111.segmentation.worker",
    );
    l.add("revision.started", { reason: "correction", taskId: "intake" });
    const first = l.open("segmentation", "review-111.segmentation.worker");
    l.status("segmentation", first, "failed", "review-111.segmentation.worker");
    l.add("revision.started", { reason: "correction", taskId: "segmentation" });
    l.worker("segmentation", "review-111.segmentation.worker-2");
    l.open("segmentation", "review-111.segmentation.worker-2");
    l.worker("intake", "review-111.intake.worker");
    l.open("intake", "review-111.intake.worker");

    const revisions = reviewRun({ run, results: reviewState(l.events) })?.revisions ?? [];
    const segmentation = revisions.map((r) => r.tasks.find((t) => t.id === "segmentation"));
    expect(segmentation.map((t) => [t?.status, t?.threads.worker])).toEqual([
      ["pending", null],
      ["pending", "review-111.segmentation.worker"],
      ["failed", "review-111.segmentation.worker"],
      ["in-progress", "review-111.segmentation.worker-2"],
    ]);
    expect(segmentation[1]?.models.worker).toBe("meta/muse-spark-1.3");
    expect(segmentation.slice(0, 2).map((t) => t?.resultRevisionId)).toEqual([initial, initial]);
    expect(segmentation[2]?.dependsOn).toEqual(["intake"]);
    expect(revisions[3]?.tasks.slice(0, 2).map((t) => t.id)).toEqual(["intake", "segmentation"]);
  });

  it("returns no review without a recorded plan and accepts an empty recorded plan", () => {
    expect(reviewRun({ run, results: reviewState([]) })).toBeNull();
    const l = log();
    l.add("revision.started", { reason: "run", plan: { tasks: [] } });
    expect(reviewRun({ run, results: reviewState(l.events) })?.revisions[0]?.tasks).toEqual([]);
  });
});
