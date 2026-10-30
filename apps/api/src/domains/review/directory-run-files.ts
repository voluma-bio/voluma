/** Local run storage for development: the same content-addressed keys, without writing to R2. */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { evidenceKey } from "@voluma/contracts/r2";
import { HTTPException } from "hono/http-exception";
import type { RunFiles } from "../../ports";

export function directoryRunFiles(root: string): RunFiles {
  return {
    async put(runId, sha256, bytes, signal) {
      const path = join(root, evidenceKey(runId, sha256));
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporary, bytes, { flag: "wx", signal });
        // Publish only complete bytes. A concurrent save of this hash needs no replacement.
        await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      } catch {
        throw new HTTPException(502, { message: "Could not save the screenshot." });
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
    async open(runId, sha256, signal) {
      const path = join(root, evidenceKey(runId, sha256));
      try {
        const info = await stat(path);
        return {
          body: Readable.toWeb(createReadStream(path, { signal })) as ReadableStream<Uint8Array>,
          byteLength: info.size,
        };
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        throw new HTTPException(missing ? 404 : 502, {
          message: missing ? "File not found." : "Could not read the file.",
        });
      }
    },
  };
}
