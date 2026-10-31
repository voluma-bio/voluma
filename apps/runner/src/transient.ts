/**
 * Retrying what a later try can clear: Modal gRPC errors and socket errors, the latter often
 * wrapped (an `AggregateError` from a connect that failed on every address, a store client's
 * `cause`). One backoff loop for the runner's setup calls.
 */
import { setTimeout } from "node:timers/promises";
import { errorText, MAX_CAUSE_DEPTH } from "@voluma/harness/error-text";

// gRPC codes (CANCELLED, UNKNOWN, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE) and
// socket errors that a later try can clear. Anything else (UNAUTHENTICATED, PERMISSION_DENIED,
// INVALID_ARGUMENT, ...) is permanent and must fail the claim with its message. NOT_FOUND on a
// sandbox is not a failure: it is already gone, which is what the caller wants.
const TRANSIENT_GRPC = new Set([1, 2, 4, 8, 13, 14]);
const TRANSIENT_SOCKET = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"]);

export const RETRY_MS = { first: 2000, max: 30_000 };

export function isTransient(e: unknown, depth = 0): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "number") return TRANSIENT_GRPC.has(code);
  if (typeof code === "string" && TRANSIENT_SOCKET.has(code)) return true;
  if (depth >= MAX_CAUSE_DEPTH) return false;
  const { errors, cause } = (e ?? {}) as { errors?: unknown; cause?: unknown };
  return (
    (Array.isArray(errors) && errors.some((inner) => isTransient(inner, depth + 1))) ||
    (cause !== undefined && isTransient(cause, depth + 1))
  );
}

/**
 * Runs `attempt`, retrying a transient failure (`isTransient`) with a doubling, capped wait,
 * `attempts` times in all (forever when unbounded), then throws. A permanent failure throws at
 * once, and so does an abort of `signal`, which also cuts a wait short.
 */
export async function withTransientRetry<T>(
  what: string,
  signal: AbortSignal,
  log: (line: string) => void,
  attempt: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  for (let n = 1, wait = RETRY_MS.first; ; n++, wait = Math.min(wait * 2, RETRY_MS.max)) {
    try {
      return await attempt();
    } catch (e) {
      signal.throwIfAborted();
      if (n >= attempts || !isTransient(e)) throw e;
      log(`${what} failed (${errorText(e)}), retrying in ${wait / 1000} s`);
      await setTimeout(wait, undefined, { signal });
    }
  }
}
