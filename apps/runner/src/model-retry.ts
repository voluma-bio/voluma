/**
 * Retries a model call that failed on the provider's side before streaming any content, for
 * every role (the main thread too). Pi's own retries (`maxRetries`, set in `run.ts`) cover 408,
 * 429, 5xx and dropped connections a few times and treat Meta's `404 model_not_found` as final;
 * that 404 hit about half of all calls on 2026-10-28, so this wrapper keeps going on those
 * errors and on that 404 (only from the `meta` provider) with exponential backoff capped at
 * MAX_DELAY_MS, until BUDGET_MS of waiting is spent. Then the last error ends the call as before
 * and the supervisor takes over (`provider-error.ts`).
 */
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isTransientProviderError } from "./provider-error.ts";

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const BUDGET_MS = 4 * 60_000;

type Stream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** `stream`, but a transient provider error before any content is retried; `onRetry` logs each. */
export function retryTransient(
  stream: Stream,
  onRetry: (attempt: number, delayMs: number, error: string) => void,
  sleep = wait,
): Stream {
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    const signal = options?.signal;
    (async () => {
      let waited = 0;
      for (let attempt = 1; ; attempt++) {
        let started: AssistantMessageEvent | undefined;
        let content = false;
        let failed: AssistantMessage | undefined;
        for await (const event of stream(model, context, options)) {
          if (event.type === "start") started = event;
          else if (event.type === "error" && !content) failed = event.error;
          else {
            if (started) out.push(started);
            started = undefined;
            content = true;
            out.push(event);
          }
        }
        if (!failed) return;
        const delay =
          Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1)) *
          (0.75 + Math.random() * 0.25);
        if (
          waited + delay > BUDGET_MS ||
          signal?.aborted ||
          !isTransientProviderError(model.provider, failed.errorMessage)
        ) {
          if (started) out.push(started);
          out.push({ type: "error", reason: failed.stopReason as "error", error: failed });
          return;
        }
        onRetry(attempt, delay, failed.errorMessage ?? "");
        waited += delay;
        await sleep(delay, signal);
      }
    })().catch((e) => {
      out.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: e instanceof Error ? e.message : String(e),
        } as unknown as AssistantMessage,
      });
    });
    return out;
  };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
