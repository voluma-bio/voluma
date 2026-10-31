/**
 * Which model-call errors are the provider's, and when they happened. Pi's own retries
 * (`model-fetch.ts`) are the only ones, and they cover only the request up to its response
 * headers. An error that survives them reaches the run loop (`run-loop.ts`):
 * - `"fatal"`: no later call can succeed (a 4xx, an empty account). Fails the run on any thread.
 * - `"transient"`: Pi retried it and gave up, before any reply. Fails the run on the main agent.
 * - `"interrupted"`: the reply had started (a stream drop, an error sent inside the stream), which
 *   Pi never retries. The main agent is resumed once; a second one fails the run.
 * On a worker or check, `"transient"` and `"interrupted"` leave a failed thread and main decides.
 * Whether the reply started is what `model-fetch.ts` saw; the text of the error is read only for
 * a fatal one and for a transient one (shapes and status: `@voluma/harness/context-overflow`).
 */
import {
  isContextOverflowError,
  isTransientProviderError,
  OUT_OF_MONEY,
  statusOf,
} from "@voluma/harness/context-overflow";
import type { ProviderFailure } from "@voluma/harness/supervise-run";

/**
 * What a failed thread's error means for the run: `undefined` when it is not the provider's (a
 * context overflow is the thread's own, a fresh thread cures it). `replyStarted`: the call's
 * response headers arrived, so every error is the stream's and none was retried, whatever its
 * text, which differs by provider.
 */
export function providerFailure(
  message: string | undefined,
  replyStarted: boolean,
): ProviderFailure | undefined {
  const m = message ?? "";
  if (isContextOverflowError(m)) return;
  const transient = isTransientProviderError(m);
  if (!transient && (OUT_OF_MONEY.test(m) || (statusOf(m) ?? 0) >= 400)) return "fatal";
  if (replyStarted) return "interrupted";
  return transient ? "transient" : undefined;
}
