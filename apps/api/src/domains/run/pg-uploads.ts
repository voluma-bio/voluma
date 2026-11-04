/**
 * Postgres adapter for upload rows: an `inputs` row that is `uploading` from create until
 * complete finds every declared file in storage (`inputs.ts`). Reads apply the caller's
 * `Reader`, like every other read of an input.
 */
import type { UploadFile } from "@voluma/contracts/run";
import { and, eq, gt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Reader } from "../../domain";
import { readableInputs, toInput } from "./pg-runs";
import { inputs } from "./schema";

export function pgUploads(db: PostgresJsDatabase) {
  return {
    /**
     * Creates the upload unless `userId` already has `maxOpen` uploads in progress, or their
     * stored total plus this scan would pass `capBytes`. Stored bytes are the declared sizes
     * of their ready uploads; open bytes those of uploads still in progress and created after
     * `since` (the PUT URL lifetime; complete refuses older ones, so they stop counting
     * for good). The reference scan is not an upload and never counts. A per-user advisory
     * lock makes the checks and the insert atomic.
     */
    async create(
      upload: {
        id: string;
        labId: string;
        uploadedBy: string;
        name: string;
        files: UploadFile[];
      },
      limits: { capBytes: number; maxOpen: number },
      since: Date,
    ): Promise<
      | { ok: true }
      | { ok: false; reason: "open" }
      | { ok: false; reason: "cap"; storedBytes: number; openBytes: number }
    > {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`upload-cap:${upload.uploadedBy}`}))`,
        );
        const rows = await tx
          .select({ files: inputs.files, status: inputs.status })
          .from(inputs)
          .where(
            and(
              eq(inputs.uploadedBy, upload.uploadedBy),
              eq(inputs.source, "upload"),
              or(
                eq(inputs.status, "ready"),
                and(eq(inputs.status, "uploading"), gt(inputs.createdAt, since)),
              ),
            ),
          );
        const sum = (files: UploadFile[]) => files.reduce((n, f) => n + f.size, 0);
        let storedBytes = 0;
        let openBytes = 0;
        let open = 0;
        for (const r of rows) {
          const bytes = sum((r.files ?? []) as UploadFile[]);
          if (r.status === "ready") storedBytes += bytes;
          else {
            openBytes += bytes;
            open += 1;
          }
        }
        if (open >= limits.maxOpen) return { ok: false, reason: "open" };
        if (storedBytes + openBytes + sum(upload.files) > limits.capBytes) {
          return { ok: false, reason: "cap", storedBytes, openBytes };
        }
        await tx.insert(inputs).values({ ...upload, source: "upload", status: "uploading" });
        return { ok: true };
      });
    },

    /**
     * The caller's own upload `id`, with its status and declared files. Only its uploader
     * may complete it, and an uncompleted upload is invisible to everyone else.
     */
    async findOwn(reader: Reader, userId: string, id: string) {
      const [row] = await db
        .select()
        .from(inputs)
        .where(
          and(
            readableInputs(reader),
            eq(inputs.id, id),
            eq(inputs.source, "upload"),
            eq(inputs.uploadedBy, userId),
          ),
        );
      return row
        ? {
            input: toInput(row),
            status: row.status,
            files: row.files as UploadFile[],
            createdAt: row.createdAt,
          }
        : null;
    },

    /** Deletes the upload if it is still uploading; false if it is gone or completed. */
    async remove(id: string): Promise<boolean> {
      const gone = await db
        .delete(inputs)
        .where(and(eq(inputs.id, id), eq(inputs.status, "uploading")))
        .returning({ id: inputs.id });
      return gone.length > 0;
    },

    /** Marks the upload ready; false if a cancel deleted it first. */
    async markReady(id: string): Promise<boolean> {
      const done = await db
        .update(inputs)
        .set({ status: "ready" })
        .where(eq(inputs.id, id))
        .returning({ id: inputs.id });
      return done.length > 0;
    },
  };
}

export type PgUploads = ReturnType<typeof pgUploads>;
