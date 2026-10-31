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
