/**
 * The browser's input routes (`@voluma/contracts/run`): list the scans a run can start
 * on, and upload one: create (an `uploading` input and a presigned PUT URL per
 * file), then complete once storage holds every declared file at its declared size, or
 * cancel.
 * Uploading is for members only: a guest can list and start on inputs but not store
 * files. No file passes through here.
 */
import { randomUUID } from "node:crypto";
import { inputKey, inputPrefix, uploadKey, uploadPrefix } from "@voluma/contracts/r2";
import { type CreateUploadResponse, createUploadRequestSchema } from "@voluma/contracts/run";
import { deletePrefix, type ObjectStore } from "@voluma/object-store";
import { Hono } from "hono";
import { parseJson, readerOf, requireUser, type UserEnv } from "../../domain";
import type { RunDeps } from ".";

/** How long the PUT URLs work: long enough for 10 GB on a slow lab connection. */
const URL_TTL_SECONDS = 6 * 60 * 60;

export interface UploadLimits {
  /** Per upload. */
  maxFiles: number;
  maxBytes: number;
  /** Uncompleted, unexpired uploads per member, so abandoned ones can't pile up URLs. */
  maxOpen: number;
}

/** Every object under `prefix`: key relative to the prefix → bytes. */
async function sizesUnder(store: ObjectStore, prefix: string): Promise<Map<string, number>> {
  const { objects } = await store.list(prefix);
  return new Map(objects.map((o) => [o.key.slice(prefix.length), o.size]));
}

/** Copies each `[from, to]` inside the store (R2 copies up to 5 GB), then deletes every `from`. */
async function moveObjects(store: ObjectStore, pairs: [from: string, to: string][]): Promise<void> {
  const queue = [...pairs];
  const copyNext = async (): Promise<void> => {
    for (let pair = queue.shift(); pair; pair = queue.shift()) await store.copy(pair[0], pair[1]);
  };
  await Promise.all(Array.from({ length: 16 }, copyNext));
  await store.delete(pairs.map(([from]) => from));
}

export function inputsRoutes({ reads, uploadStore, store, uploadLimits }: RunDeps) {
  const app = new Hono<UserEnv>();
  app.use("/inputs", requireUser);
  app.use("/inputs/*", requireUser);

  app.get("/inputs", async (c) => c.json({ inputs: await reads.listInputs(readerOf(c.var.user)) }));

  app.post("/inputs", async (c) => {
    const user = c.var.user;
    if (user.account !== "member") {
      return c.json({ error: "Sign in with a lab account to upload a scan." }, 403);
    }
    if (!store) return c.json({ error: "Scan upload is not set up on this server." }, 503);
    const { name, files } = await parseJson(c, createUploadRequestSchema);
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    if (files.length > uploadLimits.maxFiles || bytes > uploadLimits.maxBytes) {
      return c.json(
        {
          error: `A scan may have at most ${uploadLimits.maxFiles} files and ${uploadLimits.maxBytes} bytes.`,
        },
        413,
      );
    }
    const since = new Date(Date.now() - URL_TTL_SECONDS * 1000);
    if ((await uploadStore.openCount(user.userId, since)) >= uploadLimits.maxOpen) {
      return c.json(
        { error: `You have ${uploadLimits.maxOpen} uploads in progress; finish one first.` },
        429,
      );
    }
    const id = randomUUID();
    await uploadStore.create({ id, labId: user.labId, uploadedBy: user.userId, name, files });
    const expiresAt = new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString();
    const uploads = await Promise.all(
      files.map(async (f) => ({
        path: f.path,
        url: await store.presignPut(uploadKey(id, f.path), {
          size: f.size,
          expiresIn: URL_TTL_SECONDS,
        }),
      })),
    );
    return c.json({ inputId: id, uploads, expiresAt } satisfies CreateUploadResponse);
  });

  // Idempotent: a complete that failed part way through the move is finished by the next,
  // since a file counts as stored in either prefix.
  app.post("/inputs/:id/complete", async (c) => {
    const user = c.var.user;
    const id = c.req.param("id");
    const upload = await uploadStore.findOwn(readerOf(user), user.userId, id);
    if (!upload) return c.json({ error: "not found" }, 404);
    if (upload.status === "ready") return c.json(upload.input);
    if (!store) return c.json({ error: "Scan upload is not set up on this server." }, 503);
    const [staged, moved] = await Promise.all([
      sizesUnder(store, uploadPrefix(id)),
      sizesUnder(store, inputPrefix(id)),
    ]);
    const missing = upload.files
      .filter((f) => staged.get(f.path) !== f.size && moved.get(f.path) !== f.size)
      .map((f) => f.path);
    if (missing.length > 0) {
      return c.json(
        {
          error: `${missing.length} of ${upload.files.length} files are not uploaded yet.`,
          missing,
        },
        409,
      );
    }
    await moveObjects(
      store,
      upload.files
        .filter((f) => staged.get(f.path) === f.size)
        .map((f): [string, string] => [uploadKey(id, f.path), inputKey(id, f.path)]),
    );
    // A cancel that won the race deleted the row; its files may be gone.
    if (!(await uploadStore.markReady(id))) return c.json({ error: "not found" }, 404);
    return c.json(upload.input);
  });

  app.post("/inputs/:id/cancel", async (c) => {
    const user = c.var.user;
    const id = c.req.param("id");
    const upload = await uploadStore.findOwn(readerOf(user), user.userId, id);
    if (!upload) return c.json({ error: "not found" }, 404);
    if (upload.status === "ready") return c.json({ error: "The scan is already uploaded." }, 409);
    if (!store) return c.json({ error: "Scan upload is not set up on this server." }, 503);
    // The row first, and only while uploading: a complete that already marked it ready
    // keeps its files, and one still moving them then finds no row and answers 404.
    if (!(await uploadStore.remove(id))) {
      return c.json({ error: "The scan is already uploaded." }, 409);
    }
    await deletePrefix(store, uploadPrefix(id));
    await deletePrefix(store, inputPrefix(id));
    return c.body(null, 204);
  });

  return app;
}
