/**
 * Which model-call errors are the provider's, and which of them a later call can succeed after.
 * The call retry (`model-retry.ts`) retries the second set; a provider's error that survives it
 * (every 4xx) fails the run (`run-loop.ts`), and the retry set once more when it arrives mid-reply,
 * after content went out, which `model-retry.ts` cannot redo.
 * The error text is all that reaches us (shapes and status: `@voluma/harness/context-overflow`),
 * and an account out of money has its own message (`OUT_OF_MONEY`).
 */
import {
  CONNECTION,
  isContextOverflowError,
  isTransientProviderError,
  OUT_OF_MONEY,
  statusOf,
} from "@voluma/harness/context-overflow";

/**
 * What a failed thread's error means for the run: `undefined` when it is not the provider's (a
 * context overflow is the thread's own, a fresh thread cures it), `"retry"` when a later call can
 * succeed after it (`isTransientProviderError`), `"fatal"` for any other provider error: a 4xx or an empty account.
 */
export function providerFailure(message: string | undefined): "retry" | "fatal" | undefined {
  const m = message ?? "";
  if (isContextOverflowError(m)) return;
  const status = statusOf(m);
  if (isTransientProviderError(m)) return "retry";
  return CONNECTION.test(m) || OUT_OF_MONEY.test(m) || (status ?? 0) >= 400 ? "fatal" : undefined;
}
