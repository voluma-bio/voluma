/**
 * Meta intermittently answers a call that carries tools with `404 model_not_found` (about one
 * in five on 2026-10-28, with a key that works a second later). Pi's own retries
 * (`maxRetries`, which `run.ts` sets) cover 408, 429, 5xx and dropped connections but treat a
 * 404 as final, so this retries that one error: only from the `meta` provider, and only when
 * the call failed before streaming any content. Anything else ends the call as before.
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

const ATTEMPTS = 4;
const BASE_DELAY_MS = 1000;

type Stream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Pi formats provider errors as `<provider> API error (<status>): <body>`. */
export function isMetaNotFound(provider: string, message: string | undefined): boolean {
  return (
    provider === "meta" &&
    /API error \(404\)/.test(message ?? "") &&
    (message ?? "").includes('"code":"model_not_found"')
  );
}

/** `stream`, but Meta's transient 404 before any content is retried with exponential backoff. */
export function retryMetaNotFound(stream: Stream, sleep = wait): Stream {
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    const signal = options?.signal;
    (async () => {
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
        if (
          attempt >= ATTEMPTS ||
          signal?.aborted ||
          !isMetaNotFound(model.provider, failed.errorMessage)
        ) {
          if (started) out.push(started);
          out.push({ type: "error", reason: failed.stopReason as "error", error: failed });
          return;
        }
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.25), signal);
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
