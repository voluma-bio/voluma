/**
 * Keeps images out of the stored model history. Pi's messages carry a tool's images as base64
 * blocks, which made `pi_messages` the bulk of a run's database. This wraps the History port: a
 * message is stored with each image block replaced by `{type: "imageRef", key, sha256,
 * mimeType}`, the bytes (the ones the model saw, downscaled if they were) written to the thread's
 * scratch in the run's bucket (`historyImageKey`); a loaded history gets the images back.
 *
 * Rows written before this hold inline image blocks and load unchanged. An image whose object
 * is gone or no longer matches its sha256 comes back as a short text note. Only the images
 * the next request would carry are fetched (`KEEP` in `elide-images.ts`): older ones become the
 * note the request would have shown anyway.
 */
import { createHash } from "node:crypto";
import { historyImageKey } from "@voluma/contracts/r2";
import { FileNotFound, type Files } from "../../ports/files";
import type { History } from "../../ports/history";
import { parseThreadId } from "../../thread-id";
import { ELIDED_NOTE, KEEP } from "./elide-images";

type Block = { type: string; [key: string]: unknown };
type Row = { content?: unknown; [key: string]: unknown };

const blocksOf = (row: Row): Block[] | undefined =>
  Array.isArray(row.content) ? (row.content as Block[]) : undefined;

const has = (row: Row, type: string) => blocksOf(row)?.some((b) => b.type === type) === true;

export function withImageRefs(history: History, files: Files, runId: string): History {
  const signal = new AbortController().signal;
  const note = (why: string): Block => ({
    type: "text",
    text: `[an image is not available: ${why}]`,
  });

  async function fetchImage(block: Block): Promise<Block> {
    const { key, sha256, mimeType } = block as unknown as {
      key: string;
      sha256: string;
      mimeType: string;
    };
    const chunks: Uint8Array[] = [];
    try {
      for await (const chunk of files.read(key, signal)) chunks.push(chunk);
    } catch (error) {
      if (error instanceof FileNotFound) return note("its file was deleted");
      throw error;
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      return note("its file changed");
    return { type: "image", mimeType, data: bytes.toString("base64") };
  }

  return {
    async load(threadId) {
      const rows = (await history.load(threadId)).map((text) => ({
        text,
        row:
          text.includes('"imageRef"') || text.includes('"image"')
            ? (JSON.parse(text) as Row)
            : undefined,
      }));
      const withImages = rows.filter(
        (r) => r.row && (has(r.row, "image") || has(r.row, "imageRef")),
      );
      const shown = new Set(withImages.slice(-KEEP));
      return Promise.all(
        rows.map(async (r) => {
          const blocks = r.row && blocksOf(r.row);
          if (!r.row || !blocks || !has(r.row, "imageRef")) return r.text;
          const content = await Promise.all(
            blocks.map((b) =>
              b.type !== "imageRef"
                ? b
                : shown.has(r)
                  ? fetchImage(b)
                  : { type: "text", text: ELIDED_NOTE },
            ),
          );
          return JSON.stringify({ ...r.row, content });
        }),
      );
    },

    async appendMessage(threadId, idx, message) {
      if (!message.includes('"image"')) return history.appendMessage(threadId, idx, message);
      const row = JSON.parse(message) as Row;
      const blocks = blocksOf(row);
      if (!blocks || !has(row, "image")) return history.appendMessage(threadId, idx, message);
      const { name } = parseThreadId(runId, threadId);
      const content = await Promise.all(
        blocks.map(async (b) => {
          if (b.type !== "image") return b;
          const bytes = Buffer.from(b.data as string, "base64");
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const key = historyImageKey(runId, name, sha256);
          await files.write(key, bytes, signal);
          return { type: "imageRef", key, sha256, mimeType: b.mimeType };
        }),
      );
      return history.appendMessage(threadId, idx, JSON.stringify({ ...row, content }));
    },
  };
}
