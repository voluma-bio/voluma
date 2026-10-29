/**
 * Which model-call errors mean the provider is failing, not that our request was bad. Pi formats
 * a provider error as `<provider> API error (<status>): <body>`; a connection failure or client
 * timeout has no status. Used by the call retry (`model-retry.ts`), the fallback breaker
 * (`model-fallback.ts`).
 */

/** The model is unusable: key refused, model not found, timeout, rate limit, server error. */
const PROVIDER_ERROR =
  /API error \((401|403|404|408|429|5\d\d)\)|^Connection error\.?$|^Request timed out\.?$/;

/** The subset a later call can succeed after: no 401/403, and a 404 only for Meta's flaky one. */
const TRANSIENT = /API error \((408|429|5\d\d)\)|^Connection error\.?$|^Request timed out\.?$/;

export function isProviderError(message: string | undefined): boolean {
  return PROVIDER_ERROR.test(message ?? "");
}

export function isTransientProviderError(provider: string, message: string | undefined): boolean {
  const m = message ?? "";
  return (
    TRANSIENT.test(m) ||
    (provider === "meta" && /API error \(404\)/.test(m) && m.includes('"code":"model_not_found"'))
  );
}
