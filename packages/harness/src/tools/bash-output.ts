/**
 * What a `bash` command printed, as the model reads it: the combined output capped to its head
 * and tail; when that cuts something, the full text is written to the spill path through the
 * sandbox (the harness has no R2 client) and the view says so. Shared by a command that ends
 * inside its call and one that ends in the background (`bash-runtime.ts`).
 */
import type { Sandbox } from "../ports/sandbox";

const HEAD_CHARS = 4_000;
const TAIL_CHARS = 8_000;
// The stored copy holds at most this much (memory is the limit); the tail is always kept apart.
const STORE_CHARS = 4_000_000;

/** Everything a command printed, up to STORE_CHARS, plus its first and last characters. */
export class OutputBuffer {
  total = 0;
  head = "";
  tail = "";
  readonly #stored: string[] = [];
  #storedChars = 0;

  add(text: string): void {
    this.total += text.length;
    if (this.#storedChars < STORE_CHARS) {
      this.#stored.push(text);
      this.#storedChars += text.length;
    }
    const intoHead = text.slice(0, HEAD_CHARS - this.head.length);
    this.head += intoHead;
    this.tail = (this.tail + text.slice(intoHead.length)).slice(-TAIL_CHARS);
  }

  get cut(): boolean {
    return this.total > HEAD_CHARS + TAIL_CHARS;
  }

  stored(): string {
    return this.#stored.join("").slice(0, STORE_CHARS);
  }

  /** The last `chars` characters printed so far (at most what the tail keeps, unless nothing was cut). */
  recent(chars: number): string {
    return (this.cut ? this.tail : this.head + this.tail).slice(-chars);
  }
}

export interface ModelView {
  output: string;
  /** The full output is stored at the spill path. */
  truncated: boolean;
}

export async function modelView(
  output: OutputBuffer,
  sandbox: Sandbox,
  path: string,
  signal?: AbortSignal,
): Promise<ModelView> {
  if (!output.cut) return { output: output.head + output.tail, truncated: false };
  const text = output.stored();
  const omitted = output.total - HEAD_CHARS - TAIL_CHARS;
  let note = `${omitted} of ${output.total} characters omitted. read ${path} for the rest of the output`;
  let stored = true;
  try {
    await sandbox.writeFile(path, new TextEncoder().encode(text), signal);
    if (text.length < output.total)
      note += `, which holds only the first ${text.length} characters`;
  } catch (error) {
    // The command ran; its result must reach the model even when the copy is lost.
    stored = false;
    note = `${omitted} of ${output.total} characters omitted; full output not saved (${String(error)})`;
  }
  return { output: `${output.head}\n[${note}]\n${output.tail}`, truncated: stored };
}
