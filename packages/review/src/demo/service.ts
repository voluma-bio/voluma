/** In-memory simulation, reset on page reload. No network, model, or scientific computation.
 * Snapshots preserve old evidence; deduplicated confirmations cannot create two revisions.
 */
import {
  type CorrectionProposal,
  correctionRequestSchema,
  type ReviewRun,
  type ReviewTask,
} from "@voluma/contracts";
import type { DemoControls, ReviewService } from "../service";
import { createFixture } from "./fixture";

export function createDemoService(): {
  service: ReviewService;
  controls: DemoControls;
} {
  let run = createFixture();
  let failLoad = false;
  let failRerun = false;
  let running = false;
  const proposals = new Map<string, CorrectionProposal>();
  const confirmations = new Map<string, Promise<ReviewRun>>();
  const pause = (ms = 250) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  const latest = () => run.revisions[run.revisions.length - 1];
  const assertRun = (id: string) => {
    if (id !== run.id)
      throw new Error("This run is not available in the demo.");
  };
  const taskAt = (revisionId: string, taskId: string): ReviewTask => {
    const task = run.revisions
      .find((r) => r.id === revisionId)
      ?.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("This task or revision is not available.");
    return task;
  };
  const writable = (revisionId: string) => {
    if (running)
      throw new Error("A rerun is already in progress. Wait for it to finish.");
    if (revisionId !== latest().id)
      throw new Error(
        "This result has been superseded. Return to the latest revision and create a new proposal.",
      );
  };
  const record = (revisionId: string, taskId: string | null, text: string) => {
    run.record.push({
      id: crypto.randomUUID(),
      revisionId,
      taskId,
      text,
      at: new Date().toISOString(),
    });
  };

  const service: ReviewService = {
    async getRun(id) {
      await pause();
      assertRun(id);
      if (failLoad) {
        failLoad = false;
        throw new Error(
          "Simulated connection failure. Your demo session is still intact.",
        );
      }
      return structuredClone(run);
    },
    async acceptCheck(id, revisionId, taskId, checkId) {
      await pause();
      assertRun(id);
      writable(revisionId);
      const check = taskAt(revisionId, taskId).checks.find(
        (c) => c.id === checkId,
      );
      if (!check) throw new Error("This check does not exist.");
      if (check.status !== "accepted") {
        check.status = "accepted";
        record(
          revisionId,
          taskId,
          `Accepted check: ${check.title}. Measurement confidence is unchanged.`,
        );
      }
      return structuredClone(run);
    },
    async ask(id, revisionId, taskId, question) {
      await pause(500);
      assertRun(id);
      writable(revisionId);
      const text = question.trim();
      if (!text || text.length > 2000)
        throw new Error("Enter a question of 1–2000 characters.");
      const task = taskAt(revisionId, taskId);
      task.messages.push(
        { id: crypto.randomUUID(), role: "user", text },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: `Scripted demo answer, not an AI response: ${task.checker.text} ${task.actions[task.actions.length - 1]}`,
        },
      );
      record(revisionId, taskId, `Question recorded: ${text}`);
      return structuredClone(run);
    },
    async proposeCorrection(input) {
      await pause();
      const request = correctionRequestSchema.parse(input);
      assertRun(request.runId);
      writable(request.baseRevisionId);
      taskAt(request.baseRevisionId, request.taskId);
      const affected = new Set([request.taskId]);
      // Traverse to a fixed point rather than relying on the fixture's task ordering.
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of latest().tasks) {
          if (
            !affected.has(task.id) &&
            task.dependsOn.some((id) => affected.has(id))
          ) {
            affected.add(task.id);
            changed = true;
          }
        }
      }
      const proposal = {
        ...request,
        id: crypto.randomUUID(),
        affectedTaskIds: latest()
          .tasks.filter((t) => affected.has(t.id))
          .map((t) => t.id),
      };
      proposals.set(proposal.id, proposal);
      return structuredClone(proposal);
    },
    confirmCorrection(proposalId) {
      const prior = confirmations.get(proposalId);
      if (prior) return prior.then((result) => structuredClone(result));
      const proposal = proposals.get(proposalId);
      if (!proposal)
        return Promise.reject(
          new Error("This proposal is unavailable. Create a new proposal."),
        );
      try {
        writable(proposal.baseRevisionId);
      } catch (error) {
        return Promise.reject(error);
      }
      running = true;
      const shouldFail = failRerun;
      failRerun = false;
      record(
        proposal.baseRevisionId,
        proposal.taskId,
        `Confirmed simulated correction: ${proposal.instruction}`,
      );
      const confirmation = (async () => {
        try {
          await pause(1800);
          if (shouldFail) {
            record(
              proposal.baseRevisionId,
              proposal.taskId,
              "Simulated rerun failed. No results were replaced.",
            );
            throw new Error(
              "Simulated rerun failed. The earlier result is safe. Retry the same proposal.",
            );
          }
          const revision = structuredClone(latest());
          revision.id = `r${run.revisions.length + 1}`;
          revision.label = "Simulated correction";
          revision.createdAt = new Date().toISOString();
          for (const task of revision.tasks) {
            if (!proposal.affectedTaskIds.includes(task.id)) continue;
            task.resultRevisionId = revision.id;
            task.messages = [];
            task.checks = task.checks.map((check) => ({
              ...check,
              status: "open",
            }));
            task.actions = [
              `Simulated instruction: ${proposal.instruction}`,
              "No scientific computation was performed. Missing results remain unavailable.",
            ];
            task.checker = {
              verdict: "needs-review",
              text: "Simulated result only. The second agent has not checked this revision.",
            };
            // Only this demonstration has revised numbers. Never label old numbers as recomputed.
            const synthetic: Record<string, number> = {
              "trab-th": 103,
              "trab-sp": 270.3,
              "plate-medial": 180,
              "plate-lateral": 160,
            };
            task.measurements = task.measurements.map((m) => ({
              ...m,
              value: synthetic[m.id] ?? null,
              origin:
                synthetic[m.id] === undefined ? "unavailable" : "synthetic",
              references: [],
            }));
            task.evidence = task.evidence.map((asset) => ({
              ...asset,
              url: null,
              unavailableReason:
                "No new evidence was generated by the simulated rerun.",
            }));
            task.files = task.files.map((asset) => ({
              ...asset,
              url: null,
              unavailableReason:
                "No output file was generated by the simulated rerun.",
            }));
          }
          for (const structure of revision.structures) {
            if (
              revision.tasks.some(
                (t) =>
                  proposal.affectedTaskIds.includes(t.id) &&
                  t.structureIds.includes(structure.id),
              )
            ) {
              structure.status = "missing";
              structure.reason =
                "No revised segmentation was generated by the simulated rerun.";
            }
          }
          run = { ...run, revisions: [...run.revisions, revision] };
          record(
            revision.id,
            proposal.taskId,
            `Simulated revision created for ${proposal.affectedTaskIds.join(", ")}. Earlier results retained.`,
          );
          return structuredClone(run);
        } finally {
          running = false;
        }
      })();
      confirmations.set(proposalId, confirmation);
      void confirmation.catch(() => confirmations.delete(proposalId));
      return confirmation.then((result) => structuredClone(result));
    },
  };
  return {
    service,
    controls: {
      failNextLoad: () => {
        failLoad = true;
      },
      failNextRerun: () => {
        failRerun = true;
      },
    },
  };
}
