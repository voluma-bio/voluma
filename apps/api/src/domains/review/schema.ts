/** Nothing reads or writes this table any more (the screenshots feature went with the task review); it stays until a migration drops it (`apps/api/.context/TODO.md`). */
import { json, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const reviewSnapshots = pgTable(
  "review_snapshots",
  {
    runId: text().notNull(),
    generation: uuid().notNull(),
    id: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    snapshot: json().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.generation, t.id] })],
);
