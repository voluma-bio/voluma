/**
 * Run domain tables (Drizzle). `threads` is a projection of the thread.* events,
 * written in the same transaction as the event.
 *
 * `pi_messages.message` is `text`, never `jsonb`: history is read back byte for byte
 * (the retry compare and the model's prompt cache depend on it), and `jsonb` reorders
 * keys and rewrites whitespace. `events.payload` is `jsonb` because events are
 * re-serialized anyway.
 */
import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

const timestamptz = () => timestamp({ withTimezone: true });

export const threads = pgTable(
  "threads",
  {
    id: text().primaryKey(),
    runId: text().notNull(),
    parentThreadId: text().references((): AnyPgColumn => threads.id),
    kind: text().notNull(),
    task: text(),
    status: text().notNull(),
    createdAt: timestamptz().notNull(),
    endedAt: timestamptz(),
  },
  (t) => [index("threads_run").on(t.runId)],
);

/** `id` comes from the client so a retried POST is a no-op; `seq` is the stream cursor. */
export const events = pgTable(
  "events",
  {
    id: text().primaryKey(),
    runId: text().notNull(),
    threadId: text().notNull(),
    seq: integer().notNull(),
    type: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: timestamptz().notNull(),
  },
  (t) => [
    unique("events_run_seq").on(t.runId, t.seq),
    index("events_thread").on(t.threadId, t.seq),
  ],
);

export const piMessages = pgTable(
  "pi_messages",
  {
    threadId: text().notNull(),
    idx: integer().notNull(),
    message: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.idx] })],
);
