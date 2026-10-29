/**
 * Reads `model` and `max_tokens` from the start of a model call's JSON body, as the provider's
 * own parser would: only keys of the top-level object count. A sandbox controls the whole body
 * (tool schemas can hold any JSON), so a regex over the text would price a decoy nested key.
 * The reader is a small tokenizer that tracks depth and string state over the bytes it was given
 * and refuses anything it cannot be sure of: no `model` at top level in that window, a top-level
 * key that repeats (parsers disagree on which one wins), or a key spelled with an escape.
 */

export type BodyFields = { model: string; maxTokens: number | undefined };

const MAX_TOKENS_KEYS = new Set(["max_tokens", "max_output_tokens"]);
const MODEL_LENGTH = 200;

/** The fields, or the reason the gateway cannot trust the body (a 403). */
export function readBodyFields(head: string): BodyFields | string {
  let i = 0;
  const skipSpace = () => {
    while (i < head.length && " \t\r\n".includes(head[i] as string)) i++;
  };
  /** Reads a string starting at the quote; null when the window ends inside it. */
  const readString = (): { text: string; escaped: boolean } | null => {
    let escaped = false;
    const start = ++i;
    while (i < head.length) {
      const c = head[i];
      if (c === "\\") {
        escaped = true;
        i += 2;
      } else if (c === '"') return { text: head.slice(start, i++), escaped };
      else i++;
    }
    return null;
  };
  /** Steps over a value; false when the window ends inside it. */
  const skipValue = (): boolean => {
    let depth = 0;
    while (i < head.length) {
      const c = head[i] as string;
      if (c === '"') {
        if (!readString()) return false;
        if (depth === 0) return true;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (depth === 0) return true; // the enclosing object's end: this value was a literal
        if (--depth === 0) return (i++, true);
      } else if (c === "," && depth === 0) return true;
      i++;
    }
    return false;
  };

  skipSpace();
  if (head[i++] !== "{") return "the request body is not a JSON object";
  const seen = new Set<string>();
  let model: string | undefined;
  let maxTokens: number | undefined;
  for (;;) {
    skipSpace();
    if (i >= head.length || head[i] === "}") break;
    if (head[i] !== '"') return "the request body is not valid JSON";
    const key = readString();
    if (!key) break;
    if (key.escaped) return "a key in the request body is written with an escape";
    if (seen.has(key.text)) return `the request body repeats the key "${key.text}"`;
    seen.add(key.text);
    skipSpace();
    if (head[i++] !== ":") return "the request body is not valid JSON";
    skipSpace();
    const valueStart = i;
    if (!skipValue()) {
      if (key.text === "model") return "the model name is cut off by the 4 KB window";
      break;
    }
    const raw = head.slice(valueStart, i).trim();
    if (key.text === "model") {
      const quoted = /^"([^"\\]{1,200})"$/.exec(raw);
      if (!quoted) return `the model must be a plain string of up to ${MODEL_LENGTH} characters`;
      model = quoted[1];
    } else if (MAX_TOKENS_KEYS.has(key.text) && /^\d+$/.test(raw)) {
      maxTokens = Number(raw);
    }
    skipSpace();
    if (head[i] === ",") i++;
  }
  return model === undefined
    ? "no top-level model in the first 4 KB of the request"
    : { model, maxTokens };
}
