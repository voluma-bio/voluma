/** Screenshot writes share the run's lifetime lock so archiving cannot strand a successful save. */
import { type ReviewSnapshot, reviewSnapshotSchema } from "@voluma/contracts/snapshot";
import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { HTTPException } from "hono/http-exception";
import { reviewSnapshots } from "../domains/review/schema";
import { runs } from "../domains/run/schema";
import type { ReviewSnapshots } from "../ports";

export function pgSnapshots(db: PostgresJsDatabase): ReviewSnapshots {
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
      const rows = await db.transaction(async (tx) => {
        const [run] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.id, snapshot.runId), eq(runs.generation, generation)))
          .for("share");
        if (!run)
          throw new HTTPException(409, {
            message: "This run was removed or replaced. Reload the run.",
          });
        return tx
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
      });
      // A competing save may have published a different capture under this id.
      const saved = rows[0]?.snapshot ?? (await find(snapshot.runId, generation, snapshot.id));
      if (!saved) throw new Error("Snapshot insert returned no record.");
      return { snapshot: reviewSnapshotSchema.parse(saved), created: rows.length > 0 };
    },
  };
}
