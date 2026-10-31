/**
 * Review's authorized reference scan downloads. Every user of an org may read its reference
 * scan (`referenceInputId`) and no other input has an archive in storage.
 */
import { downloadDescriptorSchema } from "@voluma/contracts/download";
import { referenceInputId, referenceScanArchiveKey } from "@voluma/contracts/r2";
import type { ObjectStore } from "@voluma/object-store";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireUser, type UserEnv } from "../../domain";
import type { ReviewDeps } from ".";
import { openObject } from "./files";

export function inputRoutes({ store }: ReviewDeps) {
  const app = new Hono<UserEnv & { Variables: { store: ObjectStore } }>();
  app.use("/inputs/:inputId/*", requireUser);
  app.use("/inputs/:inputId/*", async (c, next) => {
    // Hono otherwise runs GET for HEAD and drops the body without cancelling R2.
    if (c.req.method !== "GET")
      throw new HTTPException(405, { message: "Use GET to open a scan." });
    // Uploaded inputs do not have an archive in storage yet. Never guess an R2 key.
    if (c.req.param("inputId") !== referenceInputId(c.var.user.labId))
      throw new HTTPException(404, { message: "Scan archive not found." });
    if (!store)
      throw new HTTPException(503, { message: "Reference scan storage is not configured." });
    c.set("store", store);
    c.header("Cache-Control", "private, no-store, no-transform");
    return next();
  });

  app.get("/inputs/:inputId/download", async (c) => {
    const archive = await c.var.store
      .head(referenceScanArchiveKey(), { signal: c.req.raw.signal })
      .catch(() => {
        throw new HTTPException(502, { message: "Could not read the reference scan." });
      });
    if (!archive) throw new HTTPException(404, { message: "Reference scan archive not found." });
    const { size, etag } = archive;
    if (!etag || size <= 0)
      throw new HTTPException(502, { message: "Could not read the reference scan." });
    return c.json(
      downloadDescriptorSchema.parse({
        url: `/api/review/inputs/${encodeURIComponent(c.req.param("inputId"))}/file?version=${encodeURIComponent(etag)}`,
        filename: "OA6-1RK.zip",
        mediaType: "application/zip",
        byteLength: size,
      }),
    );
  });

  app.get("/inputs/:inputId/file", async (c) => {
    const version = c.req.query("version");
    if (!version || version.length > 256)
      throw new HTTPException(400, { message: "A scan archive version is required." });
    const { body, byteLength } = await openObject(
      c.var.store,
      referenceScanArchiveKey(),
      c.req.raw.signal,
      {
        missing: "Reference scan archive not found.",
        failed: "Could not read the reference scan.",
      },
      version,
    );
    c.header("Content-Type", "application/zip");
    c.header("Content-Length", String(byteLength));
    c.header("Content-Disposition", 'attachment; filename="OA6-1RK.zip"');
    return c.body(body);
  });
  return app;
}
