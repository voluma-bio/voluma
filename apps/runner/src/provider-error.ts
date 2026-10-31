/**
 * Which model-call errors are the provider's, and whether a later call can succeed after them.
 * Pi's own retries (`model-fetch.ts`) are the only ones; an error that survives them reaches the
 * run loop (`run-loop.ts`), which fails the run for a `"fatal"` one on any thread and for a
 * `"transient"` one on the main agent only. A worker or check that failed transiently is a failed
 * thread like any other, and main decides.
 * The error text is all that reaches us (shapes and status: `@voluma/harness/context-overflow`),
 * and an account out of money has its own message (`OUT_OF_MONEY`).
 */
import {
  isContextOverflowError,
  isTransientProviderError,
  OUT_OF_MONEY,
  statusOf,
} from "@voluma/harness/context-overflow";

/**
 * What a failed thread's error means for the run: `undefined` when it is not the provider's (a
 * context overflow is the thread's own, a fresh thread cures it), `"transient"` when a later call
 * can succeed after it (`isTransientProviderError`), `"fatal"` for any other provider error: a
 * 4xx or an empty account.
 */
export function providerFailure(message: string | undefined): "transient" | "fatal" | undefined {
  const m = message ?? "";
  if (isContextOverflowError(m)) return;
  if (isTransientProviderError(m)) return "transient";
  return OUT_OF_MONEY.test(m) || (statusOf(m) ?? 0) >= 400 ? "fatal" : undefined;
}
