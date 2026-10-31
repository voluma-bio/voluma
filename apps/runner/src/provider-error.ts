/**
 * Which model-call errors are the provider's and cannot be cured by a fresh thread, read from the
 * error text (shapes and status: `@voluma/harness/context-overflow`). Pi's own retries
 * (`model-fetch.ts`) are the only ones, and they cover only the request up to its response
 * headers. What the run loop (`run-loop.ts`) does with the result:
 * - `"fatal"`: no later call can succeed (a 4xx, an empty account). Fails the run on any thread.
 * - `"transient"`: Pi retried it and gave up, before any reply. Fails the run on the main agent.
 * - `undefined`: not the provider's, or an error whose text says nothing. Whether the reply had
 *   started is the thread's own record (`thread.ended`'s `interrupted`), which the loop reads
 *   and which overrides `"transient"`: that is the case the main agent is resumed once.
 * On a worker or check any failure leaves a failed thread and main decides.
 */
import {
  isContextOverflowError,
  isTransientProviderError,
  OUT_OF_MONEY,
  statusOf,
} from "@voluma/harness/context-overflow";
import type { ProviderError } from "@voluma/harness/supervise-run";

/** `undefined` for a context overflow (the thread's own, a fresh thread cures it) and for any text that is neither. */
export function providerFailure(message: string | undefined): ProviderError | undefined {
  const m = message ?? "";
  if (isContextOverflowError(m)) return;
  if (isTransientProviderError(m)) return "transient";
  return OUT_OF_MONEY.test(m) || (statusOf(m) ?? 0) >= 400 ? "fatal" : undefined;
}
