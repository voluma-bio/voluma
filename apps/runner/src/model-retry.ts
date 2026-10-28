/**
 * Retries a model call that failed before it produced any output, so one flaky call does not
 * fail a worker thread. Transient means a 408, 429 or 5xx, a dropped connection, or Meta's
 * intermittent `404 model_not_found` (seen on about one call in five that carries tools,
 * with a key that works a second later). Any other error ends the call as before. A call that
 * failed after streaming content is not retried: its partial output is already delivered.
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
export function isTransientModelError(provider: string, message: string | undefined): boolean {
  if (!message) return false;
  const status = /API error \((\d{3})\)/.exec(message)?.[1];
  if (status) {
    const code = Number(status);
    if (code === 408 || code === 429 || code >= 500) return true;
    return provider === "meta" && code === 404 && message.includes('"code":"model_not_found"');
  }
  return /connection error|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|terminated/i.test(
    message,
  );
}

/** `stream`, but a transient failure before any content is retried with exponential backoff. */
export function withModelRetry(stream: Stream, sleep = wait): Stream {
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
        const retry =
          attempt < ATTEMPTS &&
          !signal?.aborted &&
          isTransientModelError(model.provider, failed.errorMessage);
        if (!retry) {
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
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
