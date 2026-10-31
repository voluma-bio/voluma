/**
 * Retries a model call that failed on the provider's side before streaming any content, for
 * every role (the main thread too): a timeout, a rate limit, a 5xx or a dropped connection, with
 * exponential backoff until BUDGET_MS has passed since the first attempt (Pi's own tries inside an
 * attempt count against it, but an attempt in flight is not cut short). Any other error, a 4xx
 * included, and the last error of a spent budget end the call at once; the run then fails with it.
 * Yields between provider events so parsing a buffered reply cannot starve lease timers.
 */
import { setImmediate } from "node:timers/promises";
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
import { isTransientProviderError } from "@voluma/harness/context-overflow";

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const BUDGET_MS = 60_000;

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
      const deadline = Date.now() + BUDGET_MS;
      for (let attempt = 1; ; attempt++) {
        let started: AssistantMessageEvent | undefined;
        let content = false;
        let failed: AssistantMessage | undefined;
        for await (const event of stream(model, context, {
          ...options,
          // All registered providers await this before normalizing each event. An
          // async iterator alone can drain buffered deltas entirely through microtasks.
          onProviderStreamEvent: async (event, model) => {
            await options?.onProviderStreamEvent?.(event, model);
            await setImmediate();
          },
        })) {
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
        const giveUp = () => {
          if (started) out.push(started);
          out.push({ type: "error", reason: failed.stopReason as "error", error: failed });
        };
        const delay =
          Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1)) *
          (0.75 + Math.random() * 0.25);
        if (
          Date.now() + delay > deadline ||
          signal?.aborted ||
          !isTransientProviderError(failed.errorMessage)
        ) {
          giveUp();
          return;
        }
        onRetry(attempt, delay, failed.errorMessage ?? "");
        await sleep(delay, signal);
        if (signal?.aborted) {
          giveUp(); // the provider's error, not the abort, is what the caller should see
          return;
        }
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
