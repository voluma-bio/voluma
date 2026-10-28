/**
 * The browser's input routes (`@voluma/contracts/run`): list the scans a run can start
 * on, and upload one (Uploads): create (an `uploading` input and a presigned PUT URL per
 * file), then complete once storage holds every declared file at its declared size.
 * Uploading is for members only: a guest can list and start on inputs but not store
 * files. No file passes through here.
 */
import { randomUUID } from "node:crypto";
import { inputKey, inputPrefix, uploadKey, uploadPrefix } from "@voluma/contracts/r2";
import { type CreateUploadResponse, createUploadRequestSchema } from "@voluma/contracts/run";
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

export function inputsRoutes({ reads, uploadStore, objects, uploadLimits }: RunDeps) {
  const app = new Hono<UserEnv>();
  app.use("/inputs", requireUser);
  app.use("/inputs/*", requireUser);

  app.get("/inputs", async (c) => c.json({ inputs: await reads.listInputs(readerOf(c.var.user)) }));

  app.post("/inputs", async (c) => {
    const user = c.var.user;
    if (user.account !== "member") {
      return c.json({ error: "Sign in with a lab account to upload a scan." }, 403);
    }
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
        url: await objects.presignPut(uploadKey(id, f.path), f.size, URL_TTL_SECONDS),
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
    const [staged, moved] = await Promise.all([
      objects.sizes(uploadPrefix(id)),
      objects.sizes(inputPrefix(id)),
    ]);
    const missing = upload.files
      .filter((f) => staged.get(f.path) !== f.size && moved.get(f.path) !== f.size)
      .map((f) => f.path);
    if (missing.length > 0) {
      return c.json({ error: `${missing.length} files are not uploaded yet.`, missing }, 409);
    }
    await objects.move(
      upload.files
        .filter((f) => staged.get(f.path) === f.size)
        .map((f): [string, string] => [uploadKey(id, f.path), inputKey(id, f.path)]),
    );
    await uploadStore.markReady(id);
    return c.json(upload.input);
  });

  return app;
}
