/**
 * Review lane's API domain, mounted at /review/: serving a run's review data
 * from R2, the per-task chat threads, and turning a correction into a rerun
 * proposal. It reaches the supervisor through a port in ReviewDeps that
 * index.ts wires to the run domain, never by importing domains/run.
 */
import type { DomainHandler } from "../../domain";

export type ReviewDeps = Record<string, never>;

export function createReview(_deps: ReviewDeps): DomainHandler {
  return () => null;
}
