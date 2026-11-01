/**
 * Run domain tables (Drizzle). `events` and `pi_messages` are keyed by run: ids are
 * unique within a run only, so a copy of a run keeps every id verbatim under a new `run_id`.
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
 */

import { referenceInputId } from "@voluma/contracts/r2";
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
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = () => timestamp({ withTimezone: true });

/** `id` comes from the client so a retried POST is a no-op; `seq` is the stream cursor. */
export const events = pgTable(
  "events",
  {
    runId: text().notNull(),
    id: text().notNull(),
    threadId: text().notNull(),
    seq: integer().notNull(),
    type: text().notNull(),
    payload: json().notNull(),
    createdAt: timestamptz().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.id] }), unique("events_run_seq").on(t.runId, t.seq)],
);

export const piMessages = pgTable(
  "pi_messages",
  {
    runId: text().notNull(),
    threadId: text().notNull(),
    idx: integer().notNull(),
    message: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.threadId, t.idx] })],
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
  id: referenceInputId(labId),
  labId,
  source: "reference",
  uploadedBy: EXAMPLES_OPERATOR,
  name: "OA6-1RK (mouse knee)",
});

/**
 * A group of runs of one workflow, one per scan (`studySchema`, `@voluma/contracts/study`).
 * `example` marks the seeded example's study. Like `runs`, no foreign keys: the rows are
 * checked where they are written (pg-queue.ts, and the operator scripts ops/import-run.ts and seed-example.ts).
 */
export const studies = pgTable(
  "studies",
  {
    id: text().primaryKey(),
    labId: text().notNull(),
    name: text().notNull(),
    workflowId: text().notNull(),
    budgetUsd: doublePrecision(),
    createdBy: text().notNull(),
    example: boolean().notNull().default(false),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [index("studies_lab").on(t.labId, t.createdAt)],
);

/** A scan of a study: the confirmed intake row. `subject` is never empty (the input's name when none was given). */
export const studyScans = pgTable(
  "study_scans",
  {
    studyId: text().notNull(),
    inputId: text().notNull(),
    subject: text().notNull(),
    group: text(),
    attributes: json().notNull().$type<Record<string, string | number | boolean>>(),
    position: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.studyId, t.inputId] })],
);

/**
 * The run record (`runSchema`) plus the server's own columns. `state` is the
 * `runStateSchema` status; `queued`'s position is computed at read time. The study names
 * the catalog workflow; `workflows` are the pins resolved at start. The lease columns are null unless the run is held.
 */
export const runs = pgTable(
  "runs",
  {
    id: text().primaryKey(),
    /** A replacement under the same id is a new lifetime, not the old run's screenshots. */
    generation: uuid().notNull().defaultRandom(),
    labId: text().notNull(),
    startedBy: text().notNull(),
    studyId: text().notNull(),
    workflows: json().notNull(),
    /** The output ids the user selected (`runSchema.selectedOutputs`); null: every output. */
    selectedOutputs: json(),
    notes: text(),
    inputId: text().notNull(),
    credentials: text({ enum: ["voluma", "visitor"] }).notNull(),
    /** The model every role of the run uses (`runSchema.model`); null for runs made before the choice existed. */
    model: text(),
    example: boolean().notNull().default(false),
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
    lastClaimEnd: text({
      enum: ["shutdown", "self-stop", "loop-stalled", "refused", "lease-expired"],
    }),
    /**
     * The lease token of the last claim the API swept as `lease-expired` and counted as a strike,
     * kept so a `released` report from that runner, still alive behind an outage, takes it back.
     */
    struckLeaseToken: text(),
    /** Seq of the latest progress event (`claim-progress.ts`), and the log's last seq when the current claim began. */
    lastProgressSeq: integer().notNull().default(0),
    claimStartSeq: integer().notNull().default(0),
    /** Consecutive claims that ended in infrastructure trouble without progress. */
    stalledClaims: integer().notNull().default(0),
    modelCostUsd: doublePrecision().notNull().default(0),
    sandboxSeconds: doublePrecision().notNull().default(0),
  },
  (t) => [
    index("runs_lab_state").on(t.labId, t.state, t.createdAt),
    index("runs_started_by").on(t.startedBy),
    index("runs_study").on(t.studyId),
  ],
);
