/**
 * Run domain tables (Drizzle). `threads` is a projection of the thread.* events,
 * written in the same transaction as the event.
 *
 * Neither table uses `jsonb`. `pi_messages.message` is `text`: history is read back
 * byte for byte (the retry compare and the model's prompt cache depend on it), and
 * `jsonb` reorders keys and rewrites whitespace. `events.payload` is `json`: `jsonb`
 * rejects `\u0000` and lone surrogate escapes, which the contract allows in
 * `tool.output` and `message` text (a binary file's first bytes), so the event would
 * be lost; `json` stores any string verbatim.
 *
 * `runs` carries the lease (holder, token, expiry) and the claim history the no-progress limit reads (`claim-progress.ts`) and the summed heartbeat
 * usage: the claim, the sweep and every ingest write judge them in one transaction by the
 * database's `now()` (pg-queue.ts). `inputs` and `runs` have no foreign keys to the
 * event tables: events are written under the run lock and must never fail on a projection.
 *
 * `threads.parent_thread_id` has no foreign key: `threads` is derived from the event
 * log, which is the record, so a projection must never fail the append (a missing
 * parent row would roll the event back).
 */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  json,
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
    parentThreadId: text(),
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
    payload: json().notNull(),
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

/**
 * A scan a run reads (`inputSchema`). The reference scan has one row per organization.
 * An upload is `uploading` from create until complete finds every declared file
 * (`files`, `[{path, size}]`) stored; only a `ready` input is listed or started on.
 */
export const inputs = pgTable("inputs", {
  id: text().primaryKey(),
  labId: text().notNull(),
  source: text({ enum: ["upload", "reference"] }).notNull(),
  uploadedBy: text().notNull(),
  name: text().notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
  status: text({ enum: ["uploading", "ready"] })
    .notNull()
    .default("ready"),
  files: json(),
});

/** The scan every org may start from: one row per org, uploaded by the examples operator. */
export const EXAMPLES_OPERATOR = "voluma-examples";
export const referenceInput = (labId: string): typeof inputs.$inferInsert => ({
  id: `reference-${labId}`,
  labId,
  source: "reference",
  uploadedBy: EXAMPLES_OPERATOR,
  name: "OA6-1RK (mouse knee)",
});

/**
 * The run record (`runSchema`) plus the server's own columns. `state` is the
 * `runStateSchema` status; `queued`'s position is computed at read time. `workflow_id`
 * names the catalog entry the run was started from; `workflows` are the
 * pins resolved at start. The lease columns are null unless the run is held.
 */
export const runs = pgTable(
  "runs",
  {
    id: text().primaryKey(),
    labId: text().notNull(),
    startedBy: text().notNull(),
    workflowId: text().notNull(),
    workflows: json().notNull(),
    /** The output ids the user selected (`runSchema.selectedOutputs`); null: every output. */
    selectedOutputs: json(),
    notes: text(),
    inputId: text().notNull(),
    credentials: text({ enum: ["voluma", "visitor"] }).notNull(),
    example: boolean().notNull().default(false),
    forkedFrom: text(),
    createdAt: timestamptz().notNull().defaultNow(),
    state: text({ enum: ["queued", "running", "awaiting-keys", "ended"] }).notNull(),
    startedAt: timestamptz(),
    awaitingSince: timestamptz(),
    /** The last claim, for the claim's round-robin across orgs. */
    claimedAt: timestamptz(),
    endedAt: timestamptz(),
    outcome: text({ enum: ["completed", "failed", "cancelled"] }),
    error: text(),
    leaseHolder: text(),
    leaseToken: text(),
    leaseExpiresAt: timestamptz(),
    /** Why the last claim ended (`claimEndReasonSchema`); the next claim carries it. Null before the first end. */
    lastClaimEnd: text({ enum: ["shutdown", "self-stop", "lease-expired"] }),
    /** Seq of the latest progress event (`claim-progress.ts`), and the log's last seq when the current claim began. */
    lastProgressSeq: integer().notNull().default(0),
    claimStartSeq: integer().notNull().default(0),
    /** Consecutive claims that ended in infrastructure trouble without progress. */
    stalledClaims: integer().notNull().default(0),
    /** Retired, never read or written (`stalledClaims` replaced it). Dropped in a later PR, once the code that read it is drained. */
    recoveries: integer().notNull().default(0),
    modelCostUsd: doublePrecision().notNull().default(0),
    sandboxSeconds: doublePrecision().notNull().default(0),
    /** Retired, never read or written. Drop after servers using the old count are drained. */
    toCheck: integer(),
  },
  (t) => [
    index("runs_lab_state").on(t.labId, t.state, t.createdAt),
    index("runs_started_by").on(t.startedBy),
  ],
);
