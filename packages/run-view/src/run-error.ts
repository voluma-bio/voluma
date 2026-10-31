/**
 * A run's or thread's error as the researcher reads it: the provider's raw response cut down,
 * and a run's error (a clause, as the API and runner write every one) framed as one statement.
 */

/**
 * A provider's raw JSON response cut down to its message; other errors keep their detail:
 * "meta API error (404): The model does not exist". A body with no message is dropped.
 */
export const plainError = (error: string) => {
  const brace = error.search(/\{\s*\\?"/);
  const head = brace < 0 ? error : error.slice(0, brace);
  const title = head.split("\n")[0]?.replace(/[:\s]+$/, "") || "Error";
  if (brace < 0) return error;
  try {
    const body = error.slice(brace);
    // Some recorded providers escaped the whole JSON body inside their error text.
    const json = JSON.parse(/^\{\s*\\"/.test(body) ? JSON.parse(`"${body}"`) : body);
    const message = json?.message ?? json?.error?.message ?? json?.error;
    if (typeof message === "string" && message) return `${title}: ${message}`;
    return title;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  // A multiline validation error may contain JSON objects inside a list, not a provider body.
  return head.includes("\n") ? error : title;
};

/** A failed run's error as one statement: "The run stopped: <clause>." */
export const stoppedText = (error: string | undefined) => {
  if (!error) return "The run failed.";
  const words = plainError(error);
  return `The run stopped: ${words}${/[.!?]$/.test(words) ? "" : "."}`;
};
