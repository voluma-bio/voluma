/** Presentation commands awaiting the shared API contract; no simulated adapter is mounted. */
import type { CorrectionProposal, CorrectionRequest, ReviewRun } from "./model";

export interface ReviewService {
  getRun(runId: string): Promise<ReviewRun>;
  acceptCheck(
    runId: string,
    revisionId: string,
    taskId: string,
    checkId: string,
  ): Promise<ReviewRun>;
  ask(runId: string, revisionId: string, taskId: string, question: string): Promise<ReviewRun>;
  proposeCorrection(request: CorrectionRequest): Promise<CorrectionProposal>;
  confirmCorrection(proposalId: string): Promise<ReviewRun>;
}
