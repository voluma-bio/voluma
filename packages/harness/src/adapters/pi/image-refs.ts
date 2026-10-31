/**
 * Keeps images out of the stored model history. Pi's messages carry a tool's images as base64
 * blocks, which made `pi_messages` the bulk of a run's database. This wraps the History port: a
 * message is stored with each image block replaced by `{type: "imageRef", key, sha256,
 * mimeType}`, the bytes (the ones the model saw, downscaled if they were) written to the thread's
 * scratch in the run's bucket (`historyImageKey`); a loaded history gets the images back.
 *
 * Rows written before this hold inline image blocks and load unchanged. An image whose object
 * is gone or no longer matches its sha256 comes back as a short text note. Only the images
 * the next request would carry are fetched, those in the messages since the latest compaction
 * (`compaction.ts`); the ones it summarized away become that note.
 *
 * A failed image read is retried once with jittered backoff. The S3 client already retries 5xx
 * and throttling; this layer covers what it gives up on or cannot see: a stream that breaks
 * mid-body, or stalls past `READ_TIMEOUT_MS`. Any error but `FileNotFound` (the one
 * classification the Files port makes) is retried; after the last attempt the image becomes a
 * note for this load only (nothing is stored, so a later resume that can read it sends the
 * image again). The note differs from the image, so the provider's prompt cache misses from that
 * message on, now and once more when the file reads again; a failed history load would stop the
 * thread instead. A row that is not valid JSON passes through for `foldHistory` to handle.
 */
import { createHash } from "node:crypto";
import { historyImageKey } from "@voluma/contracts/r2";
import { FileNotFound, type Files } from "../../ports/files";
import type { History } from "../../ports/history";
import { readRow } from "./compaction";

// view_image returns at most 1 MiB per image. Its stored object is on writable scratch,
// so check the stream before buffering it: a sandbox can replace it with a larger file.
const MAX_IMAGE_BYTES = 1024 * 1024;

const READ_ATTEMPTS = 2;
const READ_BACKOFF_MS = 500;
const READ_TIMEOUT_MS = 30_000; // per attempt, so a stalled stream throws and is retried

type Block = { type: string; [key: string]: unknown };
type Row = { content?: unknown; [key: string]: unknown };

const blocksOf = (row: Row): Block[] | undefined =>
  Array.isArray(row.content) ? (row.content as Block[]) : undefined;

const has = (row: Row, type: string) => blocksOf(row)?.some((b) => b.type === type) === true;

const GONE_NOTE = "[the images are no longer shown; call view_image again to see them]";

/** `nameOf` is a thread's name (`ThreadRecord.name`): the folder its images are written under. */
export function withImageRefs(
  history: History,
  files: Files,
  runId: string,
  nameOf: (threadId: string) => string,
): History {
  const signal = new AbortController().signal; // writes: never aborted
  const note = (why: string): Block => ({
    type: "text",
    text: `[an image is not available: ${why}]`,
  });

  async function fetchImage(threadId: string, block: Block): Promise<Block> {
    const { key, sha256, mimeType } = block as unknown as {
      key: string;
      sha256: string;
      mimeType: string;
    };
    let chunks: Uint8Array[] = [];
    for (let attempt = 1; ; attempt++) {
      chunks = [];
      let size = 0;
      try {
        for await (const chunk of files.read(key, AbortSignal.timeout(READ_TIMEOUT_MS))) {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) return note("its file exceeds the image size limit");
          chunks.push(chunk);
        }
        break;
      } catch (error) {
        if (error instanceof FileNotFound) return note("its file was deleted");
        if (attempt >= READ_ATTEMPTS) {
          console.error(
            `image-refs: repair image-unreadable: reading ${key} for thread ${threadId} failed after ${READ_ATTEMPTS} attempts, noted for this load: ${String(error)}`,
          );
          return note("its file could not be read");
        }
        console.error(
          `image-refs: reading ${key} for thread ${threadId} failed, retrying: ${String(error)}`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, READ_BACKOFF_MS * (0.5 + Math.random())),
        );
      }
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      return note("its file changed");
    return { type: "image", mimeType, data: bytes.toString("base64") };
  }

  return {
    async load(threadId) {
      const rows = (await history.load(threadId)).map((text) => ({ text, kind: readRow(text) }));
      // `keptFrom` indexes the messages: every row that is not a marker, unreadable ones too
      // (`foldHistory` keeps a place for them).
      const markers = rows.flatMap((r) => (r.kind.kind === "marker" ? [r.kind.marker] : []));
      const keptFrom = markers.at(-1)?.keptFrom ?? 0;
      let at = 0;
      return Promise.all(
        rows.map(async (r) => {
          const isMarker =
            r.kind.kind === "marker" || (r.kind.kind === "unreadable" && r.kind.marker);
          const index = isMarker ? -1 : at++;
          const row = r.kind.kind === "message" ? (r.kind.message as unknown as Row) : undefined;
          const blocks = row && blocksOf(row);
          if (!row || !blocks || !has(row, "imageRef")) return r.text;
          const content =
            index >= keptFrom
              ? await Promise.all(
                  blocks.map((b) => (b.type === "imageRef" ? fetchImage(threadId, b) : b)),
                )
              : [...blocks.filter((b) => b.type !== "imageRef"), { type: "text", text: GONE_NOTE }];
          return JSON.stringify({ ...row, content });
        }),
      );
    },

    async appendMessage(threadId, idx, message) {
      if (!message.includes('"image"')) return history.appendMessage(threadId, idx, message);
      const row = JSON.parse(message) as Row;
      const blocks = blocksOf(row);
      if (!blocks || !has(row, "image")) return history.appendMessage(threadId, idx, message);
      const name = nameOf(threadId);
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
