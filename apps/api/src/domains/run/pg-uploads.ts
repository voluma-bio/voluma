/**
 * Postgres adapter for upload rows: an `inputs` row that is `uploading` from create until
 * complete finds every declared file in storage (`uploads.ts`). Reads apply the caller's
 * `Reader`, like every other read of an input.
 */
import type { UploadFile } from "@voluma/contracts/run";
import { and, count, eq, gt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Reader } from "../../domain";
import { readableInputs, toInput } from "./pg-runs";
import { inputs } from "./schema";

export function pgUploads(db: PostgresJsDatabase) {
  return {
    async create(upload: {
      id: string;
      labId: string;
      uploadedBy: string;
      name: string;
      files: UploadFile[];
    }) {
      await db.insert(inputs).values({ ...upload, source: "upload", status: "uploading" });
    },

    /** Uploads `userId` created since `since` that are not complete. */
    async openCount(userId: string, since: Date): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(inputs)
        .where(
          and(
            eq(inputs.uploadedBy, userId),
            eq(inputs.status, "uploading"),
            gt(inputs.createdAt, since),
          ),
        );
      return row?.n ?? 0;
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
        ? { input: toInput(row), status: row.status, files: row.files as UploadFile[] }
        : null;
    },

    async markReady(id: string): Promise<void> {
      await db.update(inputs).set({ status: "ready" }).where(eq(inputs.id, id));
    },
  };
}

export type PgUploads = ReturnType<typeof pgUploads>;
