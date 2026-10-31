/**
 * The one test for "the provider refused this request as too large", and the status it reads.
 * The runner's failure classifier (`apps/runner/src/provider-error.ts`) and the thread's overflow
 * recovery (`adapters/pi/start-thread.ts`) both use it, so they cannot disagree about what an
 * overflow is. The error text is all that reaches us, in these shapes:
 * - Meta, OpenAI, Mistral via Pi: `<provider> API error (<status>): <body>`.
 * - Anthropic (SDK message): `<status> {"type":"error","error":{"type":"<type>",...}}`. An error
 *   sent mid-stream (an overloaded server) is that JSON alone, in any key order, so its
 *   documented `error.type` stands in for a status.
 * - A connection failure or client timeout: no status.
 */
import { type AssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";

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
export function statusOf(message: string): number | undefined {
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
 * Whether a failed reply's error text is a context overflow. Pi's catch-all overflow patterns also
 * match 5xx bodies ("too many tokens in the batch"), so only a 400, a 413 or no status counts.
 */
export function isContextOverflowError(message: string | undefined): boolean {
  const m = message ?? "";
  const status = statusOf(m);
  return (
    (status === undefined || status === 400 || status === 413) &&
    isContextOverflow({ stopReason: "error", errorMessage: m } as AssistantMessage)
  );
}

export const CONNECTION =
  /^Connection error\.?$|^Request timed out\.?$|^Anthropic stream ended before message_stop/;

/**
 * An account out of money: Anthropic's spend cap and empty balance are `400 invalid_request_error`
 * and OpenAI's is `429 insufficient_quota`, told apart from a bad request or a rate limit only by
 * the message.
 */
export const OUT_OF_MONEY =
  /You have reached your specified API usage limits|Your credit balance is too low|insufficient_quota/;

/**
 * The provider errors a later call can succeed after: a timeout, a rate limit, a server or
 * connection error. The runner retries these (`model-retry.ts`), and a summary that fails this way
 * is not the thread's own failure (`adapters/pi/compaction.ts`).
 */
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
