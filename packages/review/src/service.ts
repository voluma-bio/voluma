/** Review's async boundary. The app injects a simulator now and a network adapter later. */
import type {
  CorrectionProposal,
  CorrectionRequest,
  ReviewRun,
} from "@voluma/contracts";

export interface ReviewService {
  getRun(runId: string): Promise<ReviewRun>;
  acceptCheck(
    runId: string,
    revisionId: string,
    taskId: string,
    checkId: string,
  ): Promise<ReviewRun>;
  ask(
    runId: string,
    revisionId: string,
    taskId: string,
    question: string,
  ): Promise<ReviewRun>;
  proposeCorrection(request: CorrectionRequest): Promise<CorrectionProposal>;
  confirmCorrection(proposalId: string): Promise<ReviewRun>;
}

/** Demo controls are separate from the eventual API contract. */
export interface DemoControls {
  failNextRerun(): void;
  failNextLoad(): void;
}
