/**
 * The `read` tool, held by every role: a text file on the run's mounts, read host-side through the
 * thread's layout (the runner never holds scan-sized data, so a file over 8 MiB is refused). A
 * reply holds at most PAGE_CHARS characters; `offset` reads on from where the last one ended.
 */
import { z } from "zod";
import type { ThreadLayout } from "../layout";
import type { Files } from "../ports/files";
import { readWhole } from "./read-whole";
import type { Tool } from "./tool";

// Room for the full output `bash` stores (up to 4M characters).
const MAX_BYTES = 8 * 1024 * 1024;
const PAGE_CHARS = 50_000;

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "A text file under /inputs, /workflow, /outputs or /scratch; a relative path is read from your working folder.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("The character to start at; the end note of a cut reply gives the next one."),
});

export function readTool({
  layout,
  files,
}: {
  layout: ThreadLayout;
  files: Files;
}): Tool<typeof inputSchema> {
  return {
    name: "read",
    description: `Read a text file of the run: a skill's SKILL.md or reference, a worker's notes, a script, a JSON result, the full output of a cut bash call. A reply holds at most ${PAGE_CHARS} characters; a longer file ends with a note giving the offset to read on from. Paths: /inputs (the scan), /workflow (the skills, under their repo paths), /outputs/<task id>/ (the workers' result files), /scratch/<thread name>/ (a thread's working folder).`,
    input: inputSchema,
    async execute({ path, offset }, ctx) {
      const bytes = await readWhole({ layout, files }, path, MAX_BYTES, ctx.signal);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (offset > text.length)
        throw new Error(`${path} has ${text.length} characters; offset ${offset} is past its end`);
      const end = Math.min(text.length, offset + PAGE_CHARS);
      const page = text.slice(offset, end);
      const note =
        end < text.length
          ? `\n[characters ${offset}-${end} of ${text.length}. read ${path} with offset ${end} for the rest]`
          : "";
      return { output: page + note, isError: false, truncated: false };
    },
  };
}
