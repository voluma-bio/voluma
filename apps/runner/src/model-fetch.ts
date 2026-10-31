/**
 * The `fetch` Pi hands to the provider SDK for one model call. Pi retries a failed request itself
 * and logs nothing; each retry is a new `fetch`, so this logs every attempt that fails (a non-2xx
 * answer, or no answer: a timeout, a dropped connection) with the role and the attempt's number.
 * Whether another attempt follows is Pi's call (a 400 or a 401 is not retried), so a line does not
 * say; the thread's failure after the last one is logged by the run.
 *
 * It also reports the first 2xx answer: the response headers are in, so the reply has started and
 * Pi will not retry anything after it (`onReply`).
 */
export function loggedFetch(
  role: string,
  log: (line: string) => void,
  /** The call's signal: an attempt it cut short (the thread was stopped) is not a provider failure. */
  stop: AbortSignal | undefined,
  onReply: () => void,
): typeof globalThis.fetch {
  let attempt = 0;
  return async (input, init) => {
    const n = ++attempt;
    const failed = (what: string) => log(`${role} model call attempt ${n} failed: ${what}`);
    try {
      const response = await fetch(input, init);
      if (response.ok) onReply();
      else failed(`HTTP ${response.status} ${response.statusText}${retryAfter(response)}`);
      return response;
    } catch (error) {
      if (!stop?.aborted) {
        failed(init?.signal?.aborted ? "timed out waiting for the response" : describe(error));
      }
      throw error;
    }
  };
}

/** `retry-after` is seconds or an HTTP date. */
function retryAfter(response: Response): string {
  const value = response.headers.get("retry-after");
  if (!value) return "";
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? `, server asks ${Math.max(0, Math.ceil(seconds))}s` : "";
}

/** undici reports `fetch failed` and keeps the reason (ECONNRESET, a DNS error) in `cause`. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause : undefined;
  return cause ? `${error.message} (${cause.message})` : error.message;
}
