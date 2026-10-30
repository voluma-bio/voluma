/** Human screenshot metadata. Pixels live in content-addressed run storage, never in the event log. */
import type { ReviewSnapshot } from "@voluma/contracts/snapshot";
import { json, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const reviewSnapshots = pgTable(
  "review_snapshots",
  {
    runId: text().notNull(),
    generation: uuid().notNull(),
    id: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    snapshot: json().$type<ReviewSnapshot>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.generation, t.id] })],
);
