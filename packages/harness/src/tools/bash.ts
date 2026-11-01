/**
 * The `bash` tool: runs a command in the thread's sandbox. The model sees the combined
 * output capped to its head and tail; when that cuts something, the full text is
 * written to `toolOutputKey` through the sandbox (the harness has no R2 client) and
 * the result says so. Live chunks go to `ctx.output`, coalesced.
 */
import { z } from "zod";
import type { ThreadLayout } from "../layout";
import type { Sandbox } from "../ports/sandbox";
import type { Tool, ToolContext, ToolResult } from "./tool";

const HEAD_CHARS = 4_000;
const TAIL_CHARS = 8_000;
// The stored copy holds at most this much (memory is the limit); the tail is always kept apart.
const STORE_CHARS = 4_000_000;
// One live `tool.output` frame per window, or sooner when the buffer fills.
const FLUSH_MS = 300;
const FLUSH_CHARS = 8_000;

const inputSchema = z.object({
  command: z.string().min(1).describe("Shell command, run with bash -c."),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(1800)
    .default(120)
    .describe("Seconds before the command and everything it started is killed."),
});

/** `canRead`: the thread holds `read`, so a cut output's note points at it (a role file from before `read` does not). */
export function bashTool(layout: ThreadLayout, canRead: boolean): Tool<typeof inputSchema> {
  return {
    name: "bash",
    description:
      "Run a shell command in the sandbox and return its combined stdout and stderr and exit code. " +
      "Long output is cut to its start and end; the full text is kept at the path the result names. " +
      `${layout.description}\nThere is no network.`,
    input: inputSchema,
    async execute({ command, timeoutSeconds }, ctx) {
      const sandbox = await ctx.sandbox();
      const live = coalescer(ctx);
      const output = new OutputBuffer();
      let exitCode = -1;
      for await (const chunk of sandbox.exec({ command, timeoutSeconds }, ctx.signal)) {
        if (chunk.type === "exit") {
          exitCode = chunk.code;
          continue;
        }
        output.add(chunk.data);
        live.add(chunk.type, chunk.data);
      }
      live.flush();
      const view = await modelView(
        output,
        sandbox,
        layout.toolOutputPath(ctx.toolCallId),
        ctx,
        canRead,
      );
      return {
        output: `${view.output}\n[exit code ${exitCode}]`,
        isError: exitCode !== 0,
        truncated: view.truncated,
      };
    },
  };
}

/** Everything a command printed, up to STORE_CHARS, plus its first and last characters. */
class OutputBuffer {
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
}

async function modelView(
  output: OutputBuffer,
  sandbox: Sandbox,
  path: string,
  ctx: ToolContext,
  canRead: boolean,
): Promise<Pick<ToolResult, "output" | "truncated">> {
  if (!output.cut) return { output: output.head + output.tail, truncated: false };
  const text = output.stored();
  const omitted = output.total - HEAD_CHARS - TAIL_CHARS;
  let note = canRead
    ? `${omitted} of ${output.total} characters omitted. read ${path} for the rest of the output`
    : `${omitted} of ${output.total} characters omitted; full output at ${path}`;
  let stored = true;
  try {
    await sandbox.writeFile(path, new TextEncoder().encode(text), ctx.signal);
    if (text.length < output.total)
      note += `, which holds only the first ${text.length} characters`;
  } catch (error) {
    // The command ran; its result must reach the model even when the copy is lost.
    stored = false;
    note = `${omitted} of ${output.total} characters omitted; full output not saved (${String(error)})`;
  }
  return { output: `${output.head}\n[${note}]\n${output.tail}`, truncated: stored };
}

/** Batches live chunks per stream into `tool.output` frames. */
function coalescer(ctx: ToolContext) {
  const buffers = { stdout: "", stderr: "" };
  let lastFlush = Date.now();
  const flush = () => {
    lastFlush = Date.now();
    for (const stream of ["stdout", "stderr"] as const) {
      const text = buffers[stream];
      buffers[stream] = "";
      if (text) ctx.output(stream, text);
    }
  };
  return {
    add(stream: "stdout" | "stderr", text: string) {
      buffers[stream] += text;
      if (Date.now() - lastFlush >= FLUSH_MS || buffers[stream].length >= FLUSH_CHARS) flush();
    },
    flush,
  };
}
