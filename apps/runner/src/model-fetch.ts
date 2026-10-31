/**
 * The `fetch` Pi hands to the provider SDK for one model call. Pi retries a failed request itself
 * and logs nothing; each retry is a new `fetch`, so this logs every attempt that fails (a non-2xx
 * answer, or no answer: a timeout, a dropped connection), with the role and the attempt's number.
 * The last attempt's line is followed by the thread's failure; the others by a retry.
 */
export function loggedFetch(
  role: string,
  attempts: number,
  log: (line: string) => void,
  /** The run's abort: an attempt it cut short is not a provider failure. */
  stop?: AbortSignal,
): typeof globalThis.fetch {
  let attempt = 0;
  return async (input, init) => {
    const n = ++attempt;
    const failed = (what: string) =>
      log(`${role} model call attempt ${n} of ${attempts} failed: ${what}`);
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        failed(
          `HTTP ${response.status} ${response.statusText}${retryAfter ? `, server asks ${retryAfter}s` : ""}`,
        );
      }
      return response;
    } catch (error) {
      if (!stop?.aborted) failed(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
}
