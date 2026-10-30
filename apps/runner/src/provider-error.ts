/**
 * Which model-call errors are the provider's, and which of them a later call can succeed after.
 * The call retry (`model-retry.ts`) retries the second set; a provider's error that survives it
 * (every 4xx, or a 5xx or connection error that outlasts the retry) fails the run (`run-loop.ts`).
 * The error text is all that reaches us, in these shapes:
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

/** Any error of the model provider: a 4xx or 5xx status, a connection failure, an empty account. */
export function isProviderError(message: string | undefined): boolean {
  const m = message ?? "";
  return CONNECTION.test(m) || OUT_OF_MONEY.test(m) || (statusOf(m) ?? 0) >= 400;
}

/** The subset a later call can succeed after: a timeout, a rate limit, a server or connection error. */
export function isTransientProviderError(message: string | undefined): boolean {
  const m = message ?? "";
  const status = statusOf(m);
  return (
    CONNECTION.test(m) ||
    status === 408 ||
    (status === 429 && !OUT_OF_MONEY.test(m)) ||
    (status ?? 0) >= 500
  );
}
