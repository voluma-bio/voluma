/**
 * Which model-call errors mean the provider is failing, not that our request was bad. Used by the
 * call retry (`model-retry.ts`), the fallback breaker (`model-fallback.ts`) and the run loop's
 * redo (`run-loop.ts`). The error text is all that reaches us, in these shapes:
 * - Meta, OpenAI, Mistral via Pi: `<provider> API error (<status>): <body>`.
 * - Anthropic (SDK message): `<status> {"type":"error","error":{"type":"<type>",...}}`. An error
 *   sent mid-stream (an overloaded server) is that JSON alone, in any key order, so its
 *   documented `error.type` stands in for a status.
 * - An account out of money has its own message (`OUT_OF_MONEY`).
 * - A connection failure or client timeout: no status.
 */

const CONNECTION =
  /^Connection error\.?$|^Request timed out\.?$|^Anthropic stream ended before message_stop/;

/** Anthropic's documented error types, as the HTTP status each is sent with. */
const ANTHROPIC_TYPE_STATUS: Record<string, number> = {
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

/**
 * The status in the text. Pi may prefix `Server requested Ns retry delay (max: 60s). ` to the SDK
 * message; the status follows, then a JSON body, an HTML page or `status code (no body)`.
 */
function statusOf(message: string): number | undefined {
  const status =
    /API error \((\d{3})\)/.exec(message) ??
    /^(?:Server requested [^.]*\. )?(\d{3}) (?:\{|<|status code)/.exec(message);
  if (status) return Number(status[1]);
  if (!message.startsWith("{")) return undefined;
  try {
    const type = (JSON.parse(message) as { error?: { type?: unknown } }).error?.type;
    return typeof type === "string" ? ANTHROPIC_TYPE_STATUS[type] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An account out of money: Anthropic's spend cap and empty balance are `400 invalid_request_error`
 * and OpenAI's is `429 insufficient_quota`, told apart from a bad request or a rate limit only by
 * the message.
 */
const OUT_OF_MONEY =
  /You have reached your specified API usage limits|Your credit balance is too low|insufficient_quota/;

/** The model is unusable: key refused, model not found, timeout, rate limit, server error, spend cap. */
export function isProviderError(message: string | undefined): boolean {
  const m = message ?? "";
  const status = statusOf(m);
  return (
    CONNECTION.test(m) ||
    OUT_OF_MONEY.test(m) ||
    (status !== undefined && [401, 402, 403, 404, 408, 429].includes(status)) ||
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
    (status === 429 && !OUT_OF_MONEY.test(m)) ||
    (status ?? 0) >= 500 ||
    (provider === "meta" && status === 404 && m.includes('"code":"model_not_found"'))
  );
}

/** No later call can succeed on this account: key refused, billing, permission or spend cap. */
export function isFatalProviderError(message: string | undefined): boolean {
  const m = message ?? "";
  return OUT_OF_MONEY.test(m) || [401, 402, 403].includes(statusOf(m) ?? 0);
}
