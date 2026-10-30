/** Local run storage for development: the same content-addressed keys, without writing to R2. */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { evidenceKey, messageSnapshotKey } from "@voluma/contracts/r2";
import { HTTPException } from "hono/http-exception";
import type { RunFiles } from "../../ports";

export function directoryRunFiles(root: string): RunFiles {
  async function put(key: string, bytes: Uint8Array, signal?: AbortSignal) {
    const path = join(root, key);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, bytes, { flag: "wx", signal });
      // Publish only complete bytes. A concurrent save of this key needs no replacement.
      await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    } catch {
      throw new HTTPException(502, { message: "Could not save the screenshot." });
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async function open(key: string, signal: AbortSignal) {
    const path = join(root, key);
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
  }
  return {
    put: (runId, sha256, bytes, signal) => put(evidenceKey(runId, sha256), bytes, signal),
    open: (runId, sha256, signal) => open(evidenceKey(runId, sha256), signal),
    putSnapshot: (runId, messageId, png) => put(messageSnapshotKey(runId, messageId), png),
    openSnapshot: (runId, messageId, signal) => open(messageSnapshotKey(runId, messageId), signal),
    async assetUrl() {
      throw new HTTPException(503, { message: "Converted asset URLs require R2 storage." });
    },
  };
}
