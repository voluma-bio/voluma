/**
 * One HTTP call to the API's ingest routes, shared by the run-scoped client and the
 * hand-off: bearer token, the lease token header when given, a per-attempt timeout, and
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

/** `retryForMs`: keep retrying network and 5xx failures until this long has passed. */
export async function send(
  endpoint: Endpoint,
  path: string,
  init: RequestInit & { leaseToken?: string },
  retryForMs = 0,
): Promise<Response> {
  const { leaseToken, ...fetchInit } = init;
  const deadline = Date.now() + retryForMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(new URL(path, endpoint.baseUrl), {
        ...fetchInit,
        headers: {
          ...fetchInit.headers,
          authorization: `Bearer ${endpoint.token}`,
          ...(leaseToken && { [LEASE_TOKEN_HEADER]: leaseToken }),
        },
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (response.ok) return response;
      const text = await response.text();
      if (response.status === 409 && leaseLostSchema.safeParse(parseJson(text)).success) {
        throw new LeaseLost(`${path}: the run's lease is gone`);
      }
      throw new HttpError(response.status, `${path}: ${response.status} ${text}`);
    } catch (error) {
      if (
        error instanceof LeaseLost ||
        (error instanceof HttpError && error.status < 500) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(200 * 2 ** attempt, MAX_BACKOFF_MS)),
    );
  }
}

export function postJson(
  endpoint: Endpoint,
  path: string,
  body: unknown,
  options: { leaseToken?: string; retryForMs?: number } = {},
): Promise<Response> {
  return send(
    endpoint,
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      leaseToken: options.leaseToken,
    },
    options.retryForMs,
  );
}
