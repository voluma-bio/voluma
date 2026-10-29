/**
 * The `provider_calls` table: one row per call the provider gateway admits (`apps/gateway`).
 * The row is inserted `open` with its reservation when the call is admitted, and updated once
 * when the call ends. No request or reply body is stored. There is no foreign key to `runs`,
 * as for the run domain's other tables: nothing about a run may fail a row's write.
 *
 * Column names are snake_case from the camelCase keys: the database handle needs
 * `drizzle(client, { casing: "snake_case" })`, as the API's has.
 *
 * `cost_usd` is null while the cost is unknown (`open`, or `cut` with no usage seen); a null
 * cost counts as the reservation, since the provider may still bill.
 */
import { doublePrecision, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const providerCalls = pgTable(
  "provider_calls",
  {
    id: text().primaryKey(),
    runId: text().notNull(),
    /** The sandbox name the call's token was minted for, e.g. `segment.worker`. */
    sandbox: text().notNull(),
    provider: text().notNull(),
    /** `<METHOD> <path>` as matched against the provider's routes. */
    route: text().notNull(),
    model: text(),
    /** The gateway instance that admitted the call; it marks its own rows `cut` at shutdown. */
    instance: text().notNull(),
    status: text({ enum: ["open", "done", "failed", "cut"] }).notNull(),
    reservedUsd: doublePrecision().notNull(),
    costUsd: doublePrecision(),
    /** A Meta file id: set on an upload's row, and a DELETE may name only these. */
    fileId: text(),
    httpStatus: integer(),
    frames: integer(),
    inputTokens: integer(),
    outputTokens: integer(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ttfbMs: integer(),
    durationMs: integer(),
  },
  (t) => [
    index("provider_calls_run").on(t.runId),
    index("provider_calls_open").on(t.status, t.instance),
  ],
);
