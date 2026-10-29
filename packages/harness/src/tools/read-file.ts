/**
 * The main agent's `read_file`: a text file on the run's mounts, read host-side through the
 * thread's layout (the runner never holds scan-sized data, so a file over 1 MiB is refused).
 */
import { z } from "zod";
import type { ThreadLayout } from "../layout";
import type { Files } from "../ports/files";
import type { Tool } from "./tool";

const MAX_BYTES = 1024 * 1024;

const inputSchema = z.object({
  path: z.string().min(1).describe("A text file under /inputs, /outputs or /scratch."),
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
    description: `Read a text file of the run (at most 1 MiB): a worker's notes, a script, a JSON result. ${layout.description}`,
    input: inputSchema,
    async execute({ path }, ctx) {
      const key = layout.keyOf(path, "read");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of files.read(key, ctx.signal)) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error(`${path} is over ${MAX_BYTES} bytes`);
        chunks.push(chunk);
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      return { output: text, isError: false, truncated: false };
    },
  };
}
