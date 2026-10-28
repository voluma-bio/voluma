/**
 * The worker fallback model (`RUNNER_FALLBACK_MODEL`, off unless set): while a primary model is
 * failing, threads that start (a redo, the next task) start on the fallback instead. A thread
 * keeps the model it started on (`thread.started.model`, a contract), so this never switches a
 * thread mid-way, and the model each thread ran on is on its record.
 *
 * The breaker is per runner process and per primary model. A call that failed with a provider
 * error after pi's and `model-retry.ts`'s retries opens it for COOL_DOWN_MS; after that the
 * next thread tries the primary again, and fails it open again if still down. The fallback's own
 * failures change nothing. Visitor runs never use it (their key and scan go to Meta only).
 */
import type { Api, Model } from "@earendil-works/pi-ai";

export const COOL_DOWN_MS = 10 * 60_000;

/**
 * Pi formats provider errors as `<provider> API error (<status>): <body>`. The statuses that
 * say the model is unusable (key refused, model not found, timeout, rate limit, server error),
 * not a bad request of ours.
 */
const PROVIDER_ERROR = /API error \((401|403|404|408|429|5\d\d)\)/;

export const isProviderFailure = (message: string | undefined) =>
  PROVIDER_ERROR.test(message ?? "");

export interface ModelFallback {
  /** The model a new thread starts on: the primary, or the fallback while the primary is down. */
  pick(primary: Model<Api>): Model<Api>;
  /** A call on `model` ended in error; opens the breaker when it was the primary's provider failing. */
  failed(model: Model<Api>, message: string | undefined): void;
}

export function modelFallback(
  fallback: Model<Api> | undefined,
  log: (line: string) => void,
  now = Date.now,
  state: Map<string, number> = new Map(),
): ModelFallback {
  const key = (m: Model<Api>) => `${m.provider}/${m.id}`;
  return {
    pick(primary) {
      if (!fallback || key(primary) === key(fallback)) return primary;
      if ((state.get(key(primary)) ?? 0) <= now()) return primary;
      log(`${key(primary)} is failing: starting this thread on the fallback ${key(fallback)}`);
      return fallback;
    },
    failed(model, message) {
      if (!fallback || key(model) === key(fallback) || !isProviderFailure(message)) return;
      if ((state.get(key(model)) ?? 0) <= now()) {
        log(`${key(model)} failed (${message}): new threads use ${key(fallback)} for 10 min`);
      }
      state.set(key(model), now() + COOL_DOWN_MS);
    },
  };
}
