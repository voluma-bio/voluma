/**
 * Key redaction: the one function for text that leaves the process (stored events and
 * history rows, the console, a report's `error`). Apply it before any step that clips or
 * reshapes the text: a key cut in half no longer matches. It matches literal values only, so
 * a key a provider echoes back already masked or re-encoded passes through. A run's secrets are its model key and
 * Modal token, in memory for that run only (`@voluma/contracts/run`); their literal values
 * are replaced wherever they appear, including inside JSON strings.
 */

/** Real keys are far longer; a shorter secret would also match ordinary words. */
const MIN_SECRET_LENGTH = 6;
const MASK = "[redacted]";

/** `add` puts a secret minted after the run began (a gateway token) on the list. */
export type Redact = {
  (text: string): string;
  add(secret: string): void;
};

export function redactor(secrets: readonly (string | undefined)[]): Redact {
  const needles = new Set<string>();
  let ordered: string[] = [];
  const add = (secret: string | undefined) => {
    if (!secret || secret.length < MIN_SECRET_LENGTH) return;
    // The JSON-escaped form first: a secret holding a quote or backslash appears that way in
    // serialized events.
    needles.add(JSON.stringify(secret).slice(1, -1));
    needles.add(secret);
    ordered = [...needles].sort((a, b) => b.length - a.length);
  };
  for (const secret of secrets) add(secret);
  return Object.assign(
    (text: string) => ordered.reduce((out, n) => out.replaceAll(n, MASK), text),
    {
      add,
    },
  );
}
