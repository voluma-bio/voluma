/**
 * One HTTP call to the API's ingest routes, shared by the run client and the
 * claim: bearer token, the lease token header when given, a per-attempt timeout, and
 * optional retry of network and 5xx failures. A 409 whose body is `leaseLostSchema` is
 * `LeaseLost` on any call, never retried (`@voluma/contracts/runner`).
 */
import { LEASE_TOKEN_HEADER, leaseLostSchema } from "@voluma/contracts/runner";
import { LeaseLost } from "../../ports/lease-lost";

const MAX_BACKOFF_MS = 5_000;
const ATTEMPT_TIMEOUT_MS = 15_000;

export interface Endpoint {
  baseUrl: string;
  token: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // a non-JSON error body is not a lease answer
  }
}

const LOG_EVERY_MS = 30_000;

/**
 * `forMs`: keep retrying network and 5xx failures until this long has passed since the first
 * failure, or until `until` aborts (the call's owner stopped: the wait ends at once, and no
 * attempt follows a failed one). If the time runs out, `onGiveUp(firstFailureAt)` runs before the
 * error is thrown. A retrying call logs its first failure and then one every 30 s.
 * `attemptTimeoutMs` bounds each attempt.
 */
export async function send(
  endpoint: Endpoint,
  path: string,
  init: RequestInit & { leaseToken?: string },
  retry: {
    forMs?: number;
    until?: AbortSignal;
    attemptTimeoutMs?: number;
    onGiveUp?(firstFailureAt: number): void;
  } = {},
): Promise<Response> {
  const { leaseToken, ...fetchInit } = init;
  const { forMs = 0, until, attemptTimeoutMs = ATTEMPT_TIMEOUT_MS, onGiveUp } = retry;
  let firstFailureAt = 0;
  let loggedAt = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(new URL(path, endpoint.baseUrl), {
        ...fetchInit,
        headers: {
          ...fetchInit.headers,
          authorization: `Bearer ${endpoint.token}`,
          ...(leaseToken && { [LEASE_TOKEN_HEADER]: leaseToken }),
        },
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      if (response.ok) return response;
      const text = await response.text();
      if (response.status === 409 && leaseLostSchema.safeParse(parseJson(text)).success) {
        throw new LeaseLost(`${path}: the run's lease is gone`);
      }
      throw new HttpError(response.status, `${path}: ${response.status} ${text}`);
    } catch (error) {
      if (error instanceof LeaseLost || (error instanceof HttpError && error.status < 500)) {
        throw error;
      }
      firstFailureAt ||= Date.now();
      if (until?.aborted) throw error;
      if (Date.now() - firstFailureAt >= forMs) {
        onGiveUp?.(firstFailureAt);
        throw error;
      }
      if (Date.now() - loggedAt >= LOG_EVERY_MS) {
        loggedAt = Date.now();
        console.error(`${path}: will retry: ${error instanceof Error ? error.message : error}`);
      }
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        until?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(200 * 2 ** attempt, MAX_BACKOFF_MS));
      until?.addEventListener("abort", done, { once: true });
    });
  }
}

export function postJson(
  endpoint: Endpoint,
  path: string,
  body: unknown,
  options: {
    leaseToken?: string;
    retry?: Parameters<typeof send>[3];
    redact?(text: string): string;
  } = {},
): Promise<Response> {
  const text = JSON.stringify(body);
  return send(
    endpoint,
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: options.redact ? options.redact(text) : text,
      leaseToken: options.leaseToken,
    },
    options.retry,
  );
}
