/**
 * Reads `model` from a model call's JSON body, as the provider's own parser
 * would: only keys of the top-level object count. A sandbox controls the whole body (tool
 * schemas can hold any JSON), so a regex over the text would take a decoy nested key.
 *
 * `BodyScanner` is a small tokenizer that tracks depth and string state, one chunk at a time, in
 * constant memory. The gateway feeds it the first 4 KB to decide admission (`fields()`), then
 * keeps feeding it the rest of the body as it is forwarded: a `model` key that appears
 * twice (parsers disagree on which wins) or a top-level key spelled with an escape is a
 * violation, and the caller aborts the upstream request, so the call settles `cut`. Other
 * repeated keys change nothing the gateway decides on and are not tracked.
 */

export type BodyFields = { model: string };

const MODEL_LENGTH = 200;
/** Longest top-level key kept to compare; a longer one is not `model`. */
const KEY_LENGTH = 40;
/** Longest value kept; a longer one cannot be a model name. */
const VALUE_LENGTH = MODEL_LENGTH + 10;

type Mode = "open" | "key" | "keyString" | "colon" | "value" | "done";

export class BodyScanner {
  private mode: Mode = "open";
  private depth = 1; // 1 = inside the top-level object
  private inString = false;
  private escaped = false;
  private key = "";
  private keyEscaped = false;
  private keyOverflow = false;
  private raw = "";
  private rawOverflow = false;
  private seen = new Set<string>();
  private model: string | undefined;
  private violation: string | undefined;
  /** `model` while its value is being read. */
  private valueKey: "model" | undefined;

  /** Feeds the next bytes (as Latin-1, so no multibyte byte can look like a quote). The violation, if any. */
  push(chunk: Buffer | string): string | undefined {
    const text = typeof chunk === "string" ? chunk : chunk.toString("latin1");
    for (let i = 0; i < text.length && !this.violation; i++) this.step(text[i] as string);
    return this.violation;
  }

  /** The fields once the admission window has been pushed, or the reason the body cannot be trusted. */
  fields(): BodyFields | string {
    if (this.violation) return this.violation;
    // A model string whose closing quote is the last byte of the window is complete.
    const model = this.model ?? (this.valueKey === "model" ? modelOf(this.raw) : undefined);
    if (model === undefined) {
      return this.valueKey === "model"
        ? "the model name is cut off by the 4 KB window"
        : "no top-level model in the first 4 KB of the request";
    }
    return { model };
  }

  private fail(reason: string) {
    this.violation = reason;
  }

  private step(c: string) {
    switch (this.mode) {
      case "done":
        return;
      case "open":
        if (isSpace(c)) return;
        if (c !== "{") return this.fail("the request body is not a JSON object");
        this.mode = "key";
        return;
      case "key":
        if (isSpace(c) || c === ",") return;
        if (c === "}") {
          this.mode = "done";
          return;
        }
        if (c !== '"') return this.fail("the request body is not valid JSON");
        this.mode = "keyString";
        this.key = "";
        this.keyEscaped = false;
        this.keyOverflow = false;
        this.escaped = false;
        return;
      case "keyString":
        if (this.escaped) {
          this.escaped = false;
        } else if (c === "\\") {
          this.keyEscaped = true;
          this.escaped = true;
        } else if (c === '"') {
          this.mode = "colon";
          return;
        }
        if (this.key.length < KEY_LENGTH) this.key += c;
        else this.keyOverflow = true;
        return;
      case "colon":
        if (isSpace(c)) return;
        if (c !== ":") return this.fail("the request body is not valid JSON");
        if (this.keyEscaped)
          return this.fail("a key in the request body is written with an escape");
        this.startValue();
        return;
      case "value":
        return this.valueStep(c);
    }
  }

  private startValue() {
    const tracked = !this.keyOverflow && this.key === "model";
    if (tracked) {
      if (this.seen.has(this.key))
        return this.fail(`the request body repeats the key "${this.key}"`);
      this.seen.add(this.key);
    }
    this.valueKey = tracked ? "model" : undefined;
    this.raw = "";
    this.rawOverflow = false;
    this.depth = 1;
    this.inString = false;
    this.escaped = false;
    this.mode = "value";
  }

  private valueStep(c: string) {
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (c === "\\") this.escaped = true;
      else if (c === '"') this.inString = false;
    } else if (c === '"') {
      this.inString = true;
    } else if (c === "{" || c === "[") {
      this.depth++;
    } else if (c === "}" || c === "]") {
      if (this.depth === 1) {
        this.endValue();
        this.mode = this.violation ? this.mode : "done";
        return;
      }
      this.depth--;
    } else if (c === "," && this.depth === 1) {
      this.endValue();
      this.mode = "key";
      return;
    }
    if (this.valueKey === undefined) return;
    if (this.raw.length < VALUE_LENGTH) this.raw += c;
    else this.rawOverflow = true;
  }

  private endValue() {
    if (this.valueKey === undefined) return;
    const model = this.rawOverflow ? undefined : modelOf(this.raw);
    if (model === undefined) {
      return this.fail(`the model must be a plain string of up to ${MODEL_LENGTH} characters`);
    }
    this.model = model;
    this.valueKey = undefined;
  }
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";

const modelOf = (raw: string): string | undefined =>
  new RegExp(`^"([^"\\\\]{1,${MODEL_LENGTH}})"$`).exec(raw.trim())?.[1];
