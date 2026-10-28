/**
 * Key redaction: the one function for text that leaves the process (stored events and
 * history rows, the console, a report's `error`). A run's secrets are its model key and
 * Modal token, in memory for that run only (`@voluma/contracts/run`); their literal values
 * are replaced wherever they appear, including inside JSON strings.
 */

/** Real keys are far longer; a shorter secret would also match ordinary words. */
const MIN_SECRET_LENGTH = 6;
const MASK = "[redacted]";

export type Redact = (text: string) => string;

export function redactor(secrets: readonly (string | undefined)[]): Redact {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    // The JSON-escaped form first: a secret holding a quote or backslash appears that way in
    // serialized events.
    needles.add(JSON.stringify(secret).slice(1, -1));
    needles.add(secret);
  }
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((out, needle) => out.replaceAll(needle, MASK), text);
}

/** The same redaction applied to a JSON value, for events. */
export function redactJson<T>(redact: Redact, value: T): T {
  return JSON.parse(redact(JSON.stringify(value)));
}
