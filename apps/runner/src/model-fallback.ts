/**
 * The worker fallback model (`RUNNER_FALLBACK_MODEL`, off unless set): while a primary model is
 * failing, worker and check threads that start (a redo, the next task) start on the fallback
 * instead. A thread keeps the model it started on (`thread.started.model`; `run.ts` reads it
 * back for a resume; the harness refuses a resume on another model), so this never switches a
 * thread mid-way. Unsetting the fallback ends it for new threads; one that started on it keeps it.
 *
 * Not covered: the main thread's calls (a judgment, the run-start wake) stay on their own
 * model, so a Meta outage that reaches it leaves a failed task unjudged (accepted for a
 * person). Only errors with an HTTP status (Meta and OpenAI, whose messages pi prefixes with it),
 * connection failures and timeouts count as the model failing; Anthropic's are not recognised.
 *
 * The breaker is per runner process and per primary model. A call that failed after pi's and
 * `model-retry.ts`'s retries opens it for COOL_DOWN_MS; after that the next thread tries the
 * primary again, and a failure opens it again. The fallback's own failures change nothing.
 * Visitor runs never use it (their key and scan go to Meta only).
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { isProviderError } from "./provider-error.ts";

const COOL_DOWN_MS = 10 * 60_000;

export interface ModelFallback {
  /** The model a new thread starts on: the primary, or the fallback while the primary is down. */
  pick(primary: Model<Api>): Model<Api>;
  /** A call on `model` ended in error; opens the breaker when it was the primary failing. */
  failed(model: Model<Api>, message: string | undefined): void;
}

export function modelFallback(
  fallback: Model<Api> | undefined,
  log: (line: string) => void,
): ModelFallback {
  const openUntil = new Map<string, number>();
  const name = (m: Model<Api>) => `${m.provider}/${m.id}`;
  return {
    pick(primary) {
      if (!fallback || name(primary) === name(fallback)) return primary;
      if ((openUntil.get(name(primary)) ?? 0) <= Date.now()) return primary;
      log(`${name(primary)} is failing: starting this thread on the fallback ${name(fallback)}`);
      return fallback;
    },
    failed(model, message) {
      if (!fallback || name(model) === name(fallback) || !isProviderError(message)) return;
      if ((openUntil.get(name(model)) ?? 0) <= Date.now()) {
        log(
          `${name(model)} failed (${message}): new threads use ${name(fallback)} for ${COOL_DOWN_MS / 60_000} min`,
        );
      }
      openUntil.set(name(model), Date.now() + COOL_DOWN_MS);
    },
  };
}
