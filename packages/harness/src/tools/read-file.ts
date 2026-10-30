/**
 * The main agent's `read_file`: a text file on the run's mounts, read host-side through the
 * thread's layout (the runner never holds scan-sized data, so a file over 1 MiB is refused).
 */
import { z } from "zod";
import type { ThreadLayout } from "../layout";
import type { Files } from "../ports/files";
import { readWhole } from "./read-whole";
import type { Tool } from "./tool";

const MAX_BYTES = 1024 * 1024;

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "A text file under /inputs, /outputs or /scratch; a relative path is read from your working folder.",
    ),
});

export function readFileTool({
  layout,
  files,
}: {
  layout: ThreadLayout;
  files: Files;
}): Tool<typeof inputSchema> {
  return {
    name: "read_file",
    description:
      "Read a text file of the run (at most 1 MiB): a worker's notes, a script, a JSON result, a skill's SKILL.md. Paths: /inputs (the scan), /workflow (the skills, under their repo paths), /outputs/<task id>/ (the workers' result files), /scratch/<thread name>/ (a thread's working folder).",
    input: inputSchema,
    async execute({ path }, ctx) {
      const bytes = await readWhole({ layout, files }, path, MAX_BYTES, ctx.signal);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { output: text, isError: false, truncated: false };
    },
  };
}
