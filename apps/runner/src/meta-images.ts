/**
 * Sends each image to Meta once per claim. Pi puts every image of a thread's history in every
 * request as a base64 `data:` URL, so a thread re-sent megabytes on each call. Before a Meta
 * request goes out (`onPayload`), each inline image is uploaded to Meta's Files API (once; the
 * claim keeps its id) and the part refers to it by `file_id`.
 *
 * Meta's prompt cache reads the image, not how it was sent: base64 and `file_id` for the same
 * bytes share a cached prefix (measured, `muse-spark-1.3-contributor`). So any image may go
 * inline instead without a cache miss, and an id need not outlive the claim: a restart uploads
 * again. That makes every failure here safe to answer with the bytes:
 * - an upload that fails sends that image inline this call, and tries again after a pause;
 * - a request Meta answers `404 file_not_found` (an id expired or deleted) is resent with its
 *   images inline, and those ids are forgotten; `provider-error.ts` would take the 404 as fatal.
 * Uploads expire after `EXPIRES_S`, so the lab's images leave Meta's store a day after their
 * last use; an id is not sent within `REFRESH_MS` of its expiry.
 */
import { createHash } from "node:crypto";

const EXPIRES_S = 24 * 60 * 60; // Meta's longest prompt-cache retention: the bytes are worth no more
const REFRESH_MS = 2 * 60 * 60_000;
const RETRY_UPLOAD_MS = 5 * 60_000;
const UPLOAD_TIMEOUT_MS = 30_000;

type Uploaded = { fileId: string; usableUntil: number };
type Part = { type?: unknown; image_url?: unknown; file_id?: unknown; [key: string]: unknown };

/** One claim's uploads, shared by its threads. `apiKey` is the claim's Meta key: ids are per account. */
export function metaImages(baseUrl: string, apiKey: string, log: (line: string) => void) {
  const uploads = new Map<string, Promise<Uploaded | undefined>>();
  const failedAt = new Map<string, number>();
  const stats = {
    requests: 0,
    sentBytes: 0,
    inlineBytes: 0,
    uploads: 0,
    uploadBytes: 0,
    resent: 0,
  };

  async function upload(hash: string, dataUrl: string): Promise<Uploaded | undefined> {
    const comma = dataUrl.indexOf(",");
    const mimeType = dataUrl.slice(5, dataUrl.indexOf(";"));
    const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
    const form = new FormData();
    form.set("purpose", "user_data");
    form.set("expires_after[anchor]", "created_at");
    form.set("expires_after[seconds]", String(EXPIRES_S));
    form.set(
      "file",
      new Blob([bytes], { type: mimeType }),
      `${hash.slice(0, 16)}.${mimeType.split("/")[1]}`,
    );
    const started = Date.now();
    try {
      const res = await fetch(`${baseUrl}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      const { id } = (await res.json()) as { id?: string };
      if (!id) throw new Error("the reply had no file id");
      stats.uploads++;
      stats.uploadBytes += bytes.length;
      return { fileId: id, usableUntil: started + EXPIRES_S * 1000 - REFRESH_MS };
    } catch (error) {
      log(
        `meta-images: upload of a ${bytes.length}-byte image failed, sending it inline: ${String(error)}`,
      );
      failedAt.set(hash, Date.now());
      return undefined;
    }
  }

  /** The image's live file id, uploading it if needed; `undefined` sends it inline. */
  async function fileIdFor(dataUrl: string): Promise<string | undefined> {
    const hash = createHash("sha256").update(dataUrl).digest("hex");
    const known = uploads.get(hash);
    if (known) {
      const done = await known;
      if (done && done.usableUntil > Date.now()) return done.fileId;
      if (!done && Date.now() - (failedAt.get(hash) ?? 0) < RETRY_UPLOAD_MS) return undefined;
      // Another call found it stale first and is uploading it again.
      const newer = uploads.get(hash);
      if (newer !== known) return (await newer)?.fileId;
    }
    const next = upload(hash, dataUrl);
    uploads.set(hash, next);
    return (await next)?.fileId;
  }

  /** Every `input_image` part with a `data:` URL, in user messages and tool outputs. */
  function inlineImages(input: unknown): Part[] {
    const found: Part[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) for (const v of value) visit(v);
      else if (value && typeof value === "object") {
        const part = value as Part;
        if (part.type === "input_image" && typeof part.image_url === "string") {
          if (part.image_url.startsWith("data:")) found.push(part);
        } else for (const v of Object.values(part)) visit(v);
      }
    };
    visit(input);
    return found;
  }

  function forget(fileIds: Iterable<string>) {
    const gone = new Set(fileIds);
    for (const [hash, pending] of uploads)
      void pending.then((u) => {
        if (u && gone.has(u.fileId) && uploads.get(hash) === pending) uploads.delete(hash);
      });
  }

  return {
    /** One model call's hooks: Pi's `onPayload`, and a wrap of the call's `fetch`. */
    forCall(fetchFn: typeof globalThis.fetch) {
      // file id → the data URL it replaced in this call's request, for a resend.
      const swapped = new Map<string, string>();
      let inlineExtra = 0;
      const onPayload = async (params: unknown) => {
        const p = params as { input?: unknown };
        const parts = inlineImages(p.input);
        if (parts.length === 0) return undefined;
        const ids = await Promise.all(parts.map((part) => fileIdFor(part.image_url as string)));
        const replaced = new Map<Part, Part>();
        parts.forEach((part, i) => {
          const fileId = ids[i];
          if (!fileId) return;
          const { image_url, ...rest } = part;
          replaced.set(part, { ...rest, file_id: fileId });
          swapped.set(fileId, image_url as string);
          inlineExtra += (image_url as string).length - fileId.length;
        });
        if (replaced.size === 0) return undefined;
        // A copy: Pi's own messages, and the stored history, keep their bytes.
        const swap = (value: unknown): unknown =>
          Array.isArray(value)
            ? value.map(swap)
            : value && typeof value === "object"
              ? (replaced.get(value as Part) ??
                Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)])))
              : value;
        return { ...p, input: swap(p.input) };
      };
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const body = typeof init?.body === "string" ? init.body : undefined;
        if (body !== undefined) {
          stats.requests++;
          stats.sentBytes += Buffer.byteLength(body);
          stats.inlineBytes += Buffer.byteLength(body) + inlineExtra;
        }
        const res = await fetchFn(input, init);
        if (res.status !== 404 || body === undefined || swapped.size === 0) return res;
        const text = await res.clone().text();
        if (!text.includes("file_not_found")) return res;
        log(
          `meta-images: Meta lost a file this request named (${text.slice(0, 200)}); resending its images inline`,
        );
        forget(swapped.keys());
        let inline = body;
        for (const [fileId, dataUrl] of swapped)
          inline = inline.replaceAll(
            `"file_id":${JSON.stringify(fileId)}`,
            `"image_url":${JSON.stringify(dataUrl)}`,
          );
        stats.resent++;
        stats.sentBytes += Buffer.byteLength(inline);
        return fetchFn(input, { ...init, body: inline });
      };
      return { onPayload, fetch };
    },

    /** For the claim-end log: what went to Meta, against what all-inline images would have sent. */
    summary(): string {
      const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
      return `${stats.requests} requests sent ${mb(stats.sentBytes)} (${mb(stats.inlineBytes)} with every image inline); ${stats.uploads} images uploaded once, ${mb(stats.uploadBytes)}${stats.resent ? `; ${stats.resent} resent inline after file_not_found` : ""}`;
    },
  };
}
