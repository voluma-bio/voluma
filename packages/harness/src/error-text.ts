/** How many `cause`/`errors` levels deep a walk of an error looks. */
export const MAX_CAUSE_DEPTH = 3;

/**
 * One line for an error: its message, plus the `code`, the `cause` and an `AggregateError`'s
 * `errors` when it has them. A failed connect to every address has an empty `.message`, and the
 * message alone would reach the report as nothing.
 */
export function errorText(e: unknown, depth = 0): string {
  if (!(e instanceof Error)) return String(e);
  const parts = [e.message || e.name];
  const { code } = e as { code?: unknown };
  if (code !== undefined) parts.push(`[${String(code)}]`);
  if (depth < MAX_CAUSE_DEPTH) {
    if (e instanceof AggregateError)
      parts.push(`(${e.errors.map((inner) => errorText(inner, depth + 1)).join("; ")})`);
    if (e.cause !== undefined) parts.push(`caused by: ${errorText(e.cause, depth + 1)}`);
  }
  return parts.join(" ");
}
