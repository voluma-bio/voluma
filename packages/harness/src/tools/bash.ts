/**
 * The `bash` tool: runs a command in the run's sandbox. The model sees the combined
 * output capped to its head and tail; when that cuts something, the full text is
 * written to `toolOutputKey` through the sandbox's `/scratch` mount (the harness has
 * no R2 client) and the result says so. Live chunks go to `ctx.output`, coalesced.
 */
import { scratchPrefix, toolOutputKey } from "@voluma/contracts/r2";
import { z } from "zod";
import type { Sandbox } from "../ports/sandbox";
import type { Tool, ToolContext, ToolResult } from "./tool";

const HEAD_CHARS = 4_000;
const TAIL_CHARS = 8_000;
// Output past this is neither shown nor kept; the marker says so.
const KEEP_CHARS = 4_000_000;
// One live `tool.output` event per window, or sooner when the buffer fills.
const FLUSH_MS = 300;
const FLUSH_CHARS = 8_000;
// One spill command carries this much text (base64 in the command line, which the OS caps near 128 KB).
const SPILL_CHUNK_BYTES = 48_000;
const SPILL_TIMEOUT_SECONDS = 60;
// `/scratch` is the mount of scratchPrefix; a key under it is a path under the mount.
const SCRATCH_MOUNT = "/scratch";

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

export const bashTool: Tool<typeof inputSchema> = {
  name: "bash",
  description:
    "Run a shell command in the sandbox and return its combined stdout and stderr and exit code. " +
    "Long output is cut to its start and end; the full text is kept at the path the result names. " +
    "Read-only inputs are in /inputs; write results to /outputs; /scratch is for temporary files. There is no network.",
  input: inputSchema,
  async execute({ command, timeoutSeconds }, ctx) {
    const sandbox = await ctx.sandbox();
    const live = coalescer(ctx);
    const kept: string[] = [];
    let keptChars = 0;
    let total = 0;
    let exitCode = -1;
    for await (const chunk of sandbox.exec({ command, timeoutSeconds }, ctx.signal)) {
      if (chunk.type === "exit") {
        exitCode = chunk.code;
        continue;
      }
      total += chunk.data.length;
      if (keptChars < KEEP_CHARS) {
        kept.push(chunk.data);
        keptChars += chunk.data.length;
      }
      await live.add(chunk.type, chunk.data);
    }
    await live.flush();
    const full = kept.join("");
    const result = await modelView(full, total, sandbox, ctx);
    return {
      output: `${result.output}\n[exit code ${exitCode}]`,
      isError: exitCode !== 0,
      truncated: result.truncated,
    };
  },
};

async function modelView(
  full: string,
  total: number,
  sandbox: Sandbox,
  ctx: ToolContext,
): Promise<Pick<ToolResult, "output" | "truncated">> {
  if (total <= HEAD_CHARS + TAIL_CHARS) return { output: full, truncated: false };
  const key = toolOutputKey(ctx.runId, ctx.toolCallId);
  const path = `${SCRATCH_MOUNT}/${key.slice(scratchPrefix(ctx.runId).length)}`;
  await spill(sandbox, path, full);
  const dropped = total - full.length;
  const omitted = total - HEAD_CHARS - TAIL_CHARS;
  const note =
    `[${omitted} of ${total} characters omitted; full output at ${path}` +
    (dropped > 0 ? `, which holds only the first ${full.length} characters` : "") +
    "]";
  return {
    output: `${full.slice(0, HEAD_CHARS)}\n${note}\n${tail(full, total, TAIL_CHARS)}`,
    truncated: true,
  };
}

// The tail of what was kept; when output was dropped past KEEP_CHARS the end is lost.
function tail(full: string, total: number, chars: number): string {
  return total > full.length ? "" : full.slice(-chars);
}

async function spill(sandbox: Sandbox, path: string, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  const q = shellQuote(path);
  await run(sandbox, `mkdir -p "$(dirname ${q})" && : > ${q}`);
  for (let at = 0; at < bytes.length; at += SPILL_CHUNK_BYTES) {
    const chunk = base64(bytes.subarray(at, at + SPILL_CHUNK_BYTES));
    await run(sandbox, `printf %s '${chunk}' | base64 -d >> ${q}`);
  }
}

async function run(sandbox: Sandbox, command: string): Promise<void> {
  let code = -1;
  let stderr = "";
  for await (const chunk of sandbox.exec({ command, timeoutSeconds: SPILL_TIMEOUT_SECONDS })) {
    if (chunk.type === "exit") code = chunk.code;
    else if (chunk.type === "stderr") stderr += chunk.data;
  }
  if (code !== 0) throw new Error(`storing the full output failed (exit ${code}): ${stderr}`);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Batches live chunks per stream; a failed append is dropped (`tool.output` is best effort). */
function coalescer(ctx: ToolContext) {
  const buffers = { stdout: "", stderr: "" };
  let lastFlush = Date.now();
  const flush = async () => {
    lastFlush = Date.now();
    for (const stream of ["stdout", "stderr"] as const) {
      const text = buffers[stream];
      buffers[stream] = "";
      if (text) await ctx.output(stream, text).catch(() => {});
    }
  };
  return {
    async add(stream: "stdout" | "stderr", text: string) {
      buffers[stream] += text;
      if (Date.now() - lastFlush >= FLUSH_MS || buffers[stream].length >= FLUSH_CHARS)
        await flush();
    },
    flush,
  };
}
