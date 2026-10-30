/** Immutable screenshot records; the unique run/id pair arbitrates concurrent retries. */
import { type ReviewSnapshot, reviewSnapshotSchema } from "@voluma/contracts/snapshot";
import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { reviewSnapshots } from "./schema";

export function pgSnapshots(db: PostgresJsDatabase) {
  const find = async (runId: string, generation: string, id: string) => {
    const [row] = await db
      .select()
      .from(reviewSnapshots)
      .where(
        and(
          eq(reviewSnapshots.runId, runId),
          eq(reviewSnapshots.generation, generation),
          eq(reviewSnapshots.id, id),
        ),
      );
    return row ? reviewSnapshotSchema.parse(row.snapshot) : null;
  };
  return {
    find,
    async list(runId: string, generation: string) {
      const rows = await db
        .select()
        .from(reviewSnapshots)
        .where(and(eq(reviewSnapshots.runId, runId), eq(reviewSnapshots.generation, generation)))
        .orderBy(asc(reviewSnapshots.createdAt), asc(reviewSnapshots.id));
      return rows.map((row) => reviewSnapshotSchema.parse(row.snapshot));
    },
    async insert(snapshot: ReviewSnapshot, generation: string) {
      const rows = await db
        .insert(reviewSnapshots)
        .values({
          runId: snapshot.runId,
          generation,
          id: snapshot.id,
          createdAt: new Date(snapshot.createdAt),
          snapshot,
        })
        .onConflictDoNothing()
        .returning();
      // A competing save may have published a different capture under this id.
      const saved = rows[0]?.snapshot ?? (await find(snapshot.runId, generation, snapshot.id));
      if (!saved) throw new Error("Snapshot insert returned no record.");
      return { snapshot: reviewSnapshotSchema.parse(saved), created: rows.length > 0 };
    },
  };
}
