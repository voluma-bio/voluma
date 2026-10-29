/**
 * Which model-call errors mean the provider is failing, not that our request was bad. Used by the
 * call retry (`model-retry.ts`), the fallback breaker (`model-fallback.ts`) and the supervisor's
 * redo (`run.ts`). The error text is all that reaches us, in these shapes:
 * - Meta, OpenAI, Mistral via Pi: `<provider> API error (<status>): <body>`.
 * - Anthropic (SDK message): `<status> {"type":"error","error":{"type":"<type>",...}}`. An error
 *   sent mid-stream (an overloaded server) has the same JSON with no status, so its documented
 *   `error.type` stands in for one.
 * - A connection failure or client timeout: no status.
 */

const CONNECTION = /^Connection error\.?$|^Request timed out\.?$/;

/** Anthropic's documented error types, as the HTTP status each is sent with. */
const ANTHROPIC_TYPE_STATUS: Record<string, number> = {
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

function statusOf(message: string): number | undefined {
  const status = /API error \((\d{3})\)/.exec(message) ?? /^(\d{3}) \{/.exec(message);
  if (status) return Number(status[1]);
  const type = /^\{"type":"error","error":\{"type":"(\w+)"/.exec(message);
  return type ? ANTHROPIC_TYPE_STATUS[type[1] as string] : undefined;
}

/** The model is unusable: key refused, model not found, timeout, rate limit, server error. */
export function isProviderError(message: string | undefined): boolean {
  const m = message ?? "";
  const status = statusOf(m);
  return (
    CONNECTION.test(m) ||
    (status !== undefined && [401, 403, 404, 408, 429].includes(status)) ||
    (status ?? 0) >= 500
  );
}

/** The subset a later call can succeed after: no 401/403, and a 404 only for Meta's flaky one. */
export function isTransientProviderError(provider: string, message: string | undefined): boolean {
  const m = message ?? "";
  const status = statusOf(m);
  return (
    CONNECTION.test(m) ||
    status === 408 ||
    status === 429 ||
    (status ?? 0) >= 500 ||
    (provider === "meta" && status === 404 && m.includes('"code":"model_not_found"'))
  );
}
