/**
 * What a failed main agent means for the run, shared by both loops: how its provider error reads
 * and whether the run fails, the same main resumes, or a new main takes over. A loop supplies the
 * facts from its log; the actions (resume, replace) are its own.
 */
import type { ThreadEnd } from "@voluma/contracts/thread-records";

/** The host's reading of a provider error's text (`RunLoopOptions.providerError`). */
export type ProviderError = "fatal" | "transient";

/** How a failed thread's error reads: the host's reading of its text, and `interrupted` from the thread's own end. */
export function failureKind(
  end: ThreadEnd | undefined,
  providerError: ((error: string) => ProviderError | undefined) | undefined,
): ProviderError | "interrupted" | undefined {
  if (end?.status !== "failed") return undefined;
  const kind = providerError?.(end.error ?? "");
  return kind === "fatal" || !end.interrupted ? kind : "interrupted";
}

/**
 * - a failure recorded before the latest `run.reopened` belongs to an earlier request: the
 *   researcher's new request gets a fresh main (handed over from the failed one), whatever the error;
 * - a transient provider error (Pi's retries ran out before any reply) fails the run;
 * - an interrupted reply resumes the same main, history as it was, unless its previous end was
 *   an interrupted failure too and it has made no reply since its latest start: then the run fails;
 * - anything else (a context overflow, a length stop, a refusal) keeps the history that failed,
 *   so a fresh main takes over, once; if that one fails too, so does the run.
 */
export function mainFailureAction(m: {
  kind: ReturnType<typeof failureKind>;
  /** This process started the thread (a failure an earlier claim recorded is not this claim's). */
  startedHere: boolean;
  replied: boolean;
  endBefore: ThreadEnd | undefined;
  /** The main before this one failed too. */
  previousFailed: boolean;
  /** Its failure was recorded before the latest `run.reopened`: an earlier request's, not this one's. */
  failedBeforeRequest: boolean;
}): "fail" | "resume" | "replace" {
  if (m.failedBeforeRequest) return "replace";
  if (m.kind === "transient" && m.startedHere) return "fail";
  if (m.kind === "interrupted") {
    return !m.replied && m.endBefore?.status === "failed" && m.endBefore.interrupted
      ? "fail"
      : "resume";
  }
  return m.previousFailed ? "fail" : "replace";
}
