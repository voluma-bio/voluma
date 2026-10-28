/**
 * Review's authorized scan downloads, mounted at /api/review/. The composition
 * root supplies scoped input reads and storage; Review never imports Run's domain.
 */
import { downloadDescriptorSchema } from "@voluma/contracts/download";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { readerOf, requireUser, type UserEnv } from "../../domain";
import type { ReferenceArchive, ReviewInputs } from "../../ports";

export type ReviewDeps = {
  inputs: ReviewInputs;
  referenceArchive: ReferenceArchive | null;
};

export function createReview({ inputs, referenceArchive }: ReviewDeps) {
  const app = new Hono<UserEnv & { Variables: { archive: ReferenceArchive } }>().use(requireUser);
  app.use("/inputs/:inputId/*", async (c, next) => {
    // Hono otherwise runs GET for HEAD and drops the body without cancelling R2.
    if (c.req.method !== "GET")
      throw new HTTPException(405, { message: "Use GET to open a scan." });
    const available = await inputs.listInputs(readerOf(c.var.user));
    const input = available.find((item) => item.id === c.req.param("inputId"));
    // Uploaded inputs do not have an archive in storage yet. Never guess an R2 key.
    if (input?.source !== "reference")
      throw new HTTPException(404, { message: "Scan archive not found." });
    if (!referenceArchive)
      throw new HTTPException(503, { message: "Reference scan storage is not configured." });
    c.set("archive", referenceArchive);
    c.header("Cache-Control", "private, no-store, no-transform");
    return next();
  });

  app.get("/inputs/:inputId/download", async (c) => {
    const { byteLength, version } = await c.var.archive.head(c.req.raw.signal);
    return c.json(
      downloadDescriptorSchema.parse({
        url: `/api/review/inputs/${encodeURIComponent(c.req.param("inputId"))}/file?version=${encodeURIComponent(version)}`,
        filename: "OA6-1RK.zip",
        mediaType: "application/zip",
        byteLength,
      }),
    );
  });

  app.get("/inputs/:inputId/file", async (c) => {
    const version = c.req.query("version");
    if (!version || version.length > 256)
      throw new HTTPException(400, { message: "A scan archive version is required." });
    const { body, byteLength } = await c.var.archive.open(version, c.req.raw.signal);
    c.header("Content-Type", "application/zip");
    c.header("Content-Length", String(byteLength));
    c.header("Content-Disposition", 'attachment; filename="OA6-1RK.zip"');
    return c.body(body);
  });
  return app;
}
