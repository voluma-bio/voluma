/**
 * The run record and the calls on it, under `/api/run`. These calls are
 * cookie-authenticated (the rules in `auth.ts` apply); the bearer-authenticated
 * ingest routes under the same prefix are a different contract.
 *
 *   POST /api/run/runs             body `startRunRequestSchema` → 200 `runSchema`
 *                                  (404 for an unknown `workflowId` or an `inputId`
 *                                  the caller can't read; 409 and 429: see Limits)
 *   GET  /api/run/runs             → 200 `listRunsResponseSchema`, newest first
 *   GET  /api/run/runs/:id         → 200 `runSchema`
 *   POST /api/run/runs/:id/cancel  → 200 `runSchema` with state `ended`/`cancelled`
 *                                  at once, even if the runner is still stopping (the
 *                                  server records it and the runner obeys); cancelling
 *                                  an ended run is a no-op; 403 for an example run
 *   POST /api/run/runs/:id/keys    body `resendKeysRequestSchema` → 200 `runSchema`
 *                                  (409 unless the run is `awaiting-keys`; 403 unless
 *                                  the caller is its `startedBy`; 429: see Limits)
 *   GET  /api/run/inputs           → 200 `listInputsResponseSchema`, newest first: inputs a
 *                                  run can start on (an upload only once completed)
 *   POST /api/run/inputs           body `createUploadRequestSchema` → 200
 *                                  `createUploadResponseSchema`: a new upload and a URL per
 *                                  file (see Uploads); 403 for a guest; 413 over the
 *                                  server's limits
 *   POST /api/run/inputs/:id/complete → 200 `inputSchema` once every declared file is
 *                                  stored with its declared size; 409
 *                                  `completeUploadConflictSchema` listing the files that
 *                                  aren't; completing a completed upload is a no-op
 *
 * Uploads. A scan's files never pass through the API: the server answers a create
 * with a presigned `PUT` URL per file, straight to object storage (`inputKey(inputId,
 * path)` in `r2.ts`), valid until `expiresAt`. The client PUTs each file's bytes with
 * `Content-Length` equal to the declared `size` (the signature covers it; any other
 * length is refused by storage), retrying a file by PUTting it again to the same URL,
 * then calls complete. Until complete succeeds the input is not listed and a run can't
 * start on it (`startRun` answers 409). One PUT per file, no multipart: a file is at
 * most `MAX_UPLOAD_FILE_BYTES`, the object store's single-PUT limit; a scan is a folder
 * of slices, or one volume of a few GB at most, so a retry re-sends one file. Creating
 * an upload needs a member account (a guest gets 403); the files, the bytes and the
 * paths are checked against the server's limits and the rules on `uploadPathSchema`.
 * The input is the uploader's: under scope `self` only they list and start on it, under
 * `lab` the whole org does. Complete answers 404 for an input the caller can't read, and
 * 403 to a reader who isn't its uploader.
 *
 * Org scoping, enforced by the server on every call and every read:
 *   - Every read is filtered by the caller's `labId`. Another org's run or
 *     input answers 404, never 403.
 *   - When the caller's server-side scope is `self` (not in `meResponseSchema`),
 *     reads are also filtered to the caller: a run when `startedBy` is the
 *     caller's `userId` or the run is an `example`; an input when `uploadedBy`
 *     is the caller or it is the org's reference scan (`source: "reference"`),
 *     which every reader of the org can read, list and start on, so it must be
 *     cleared for public use in an org that has guests. Scope `lab`
 *     sees the org.
 *   - Example runs are read-only to everyone. Only server-side seeding (an
 *     operator script, under a dedicated operator id) sets `example`, never
 *     `startRun` or a fork, and it never changes afterwards; to change an
 *     example, re-seed it. An example always reads its org's reference scan.
 *     A correction on one never changes it: the server
 *     creates the caller's own run with `forkedFrom` set (the corrections
 *     contract), which reads the same input. One caller has at most one fork
 *     per example; later corrections apply to it.
 *   - Run-scoped records (events, corrections) inherit `labId` from their run
 *     and do not repeat it; read access to them is read access to the run.
 *     An input exists before any run and can serve several, so it carries its
 *     own `labId`.
 *   - `startRun` reads the input under the same rule: an `inputId` the caller
 *     can't read answers 404, so a visitor can't start a run on another
 *     visitor's input by guessing its id.
 *
 * Workflows: the request names a workflow from the server's catalog, never raw
 * pins, so a caller can't make the server import an arbitrary repo. The server
 * resolves the id to pinned packages and records them on the run.
 *
 * Starting work. The rules below hold for every call that creates a run or
 * makes one run again: `startRun`, a fork or a rerun after a correction (the
 * corrections contract), `/keys`, and any added later.
 *
 * Who pays (`credentials`): `visitor` when the request that creates the run
 * carries `keys`, else `voluma`. It never changes afterwards, and a `visitor`
 * run never falls back to Voluma's credentials.
 *
 * Visitor keys are the caller's own, kept in their browser. The server and the
 * runner hold them in memory for that run only: never in the database, on
 * disk, in logs or in any response (log no request body on these routes). The
 * only channel that carries them past the server is the hand-off to the runner
 * (the runner contract), which goes through no store. Text from a visitor's
 * providers (errors, SDK messages) has the key values redacted before it is
 * stored or logged. If the server or the runner loses the keys before the run
 * ends (a restart or a deploy), the run moves to `awaiting-keys` and resumes
 * when the browser resends them (`/keys`). After 24 h in `awaiting-keys` it
 * ends `failed` with an `error`. `/keys` moves the run `awaiting-keys` →
 * `queued`, where a claim picks it up. The API holds a `visitor` run's keys
 * only in memory, so on start it moves every unclaimed `visitor` run to
 * `awaiting-keys` (`startedAt` null if it never started). Both keys or none: a request with only one
 * fails validation (400). A `visitor` run's sandbox runs in the visitor's own
 * account, so its outputs are untrusted: never seed an example from one.
 *
 * Limits: each org has its own, given to the run domain by the API's
 * composition root:
 *   - per caller: at most this many runs that haven't ended, per `credentials`
 *     kind (none for an org whose members share one account); another answers
 *     409;
 *   - for `voluma` runs only: runs at once (a claim takes a `queued` run only
 *     while the org is under it), runs per day, and a dollar ceiling counted
 *     from the usage the runner reports with its heartbeats (`runner.ts`), so
 *     the run record carries no cost fields. The daily and dollar limits answer
 *     429 when work starts and are checked again when a claim dequeues a run; a
 *     run refused at dequeue, or a running one that crosses the dollar ceiling,
 *     ends `failed` with an `error`. The daily limit counts a run once, so a
 *     recovered run isn't refused for a limit it already passed;
 *   - for `visitor` runs: at most this many `queued` or `running` in the org
 *     (those hold the visitor's keys in the server's memory, or a runner
 *     slot; an `awaiting-keys` run holds neither and doesn't count). Starting
 *     one, or `/keys`, answers 429 at the cap. Only those two calls add to the
 *     count, so the claim needn't check it again.
 * Which org's run a claim takes: `runner.ts`.
 * Every run is created `queued`, and only a claim starts it (`runner.ts`). A
 * `visitor` run skips the org's runs-at-once count but still waits for a claim.
 */
import { z } from "zod";
import { userIdSchema } from "./auth";
import { inputIdSchema, runIdSchema, segmentSchema } from "./ids";
import { relativePathSchema } from "./r2";
import { workflowPinSchema } from "./workflow";

/**
 * A scan a run reads. `source` says where its files are: an `upload` lives at
 * `inputPrefix(id)`; the `reference` scan is `referencePrefix("scan")`. The
 * server derives the R2 prefix; the browser never needs it. The upload call
 * that creates inputs is a later PR; its key layout (`inputKey`) is settled in
 * `r2.ts`. Under `self`, `listInputs` lists the caller's uploads and the
 * org's reference scan.
 */
export const inputSchema = z.object({
  id: inputIdSchema,
  labId: z.string(),
  source: z.enum(["upload", "reference"]),
  uploadedBy: userIdSchema,
  name: z.string(),
});
export type Input = z.infer<typeof inputSchema>;

/** A workflow in the server's catalog. */
export const workflowIdSchema = z.string().min(1);

export const runStateSchema = z.discriminatedUnion("status", [
  /**
   * 1-based place in the org's queue; 1 starts next. The server computes it at
   * read time and doesn't store it, so the run screen polls `getRun` to see it
   * move. Under `self`, it still counts other visitors' runs (only a count leaks).
   * A `visitor` run is not held by the org's runs-at-once limit, so its
   * position is always 1: it waits only for a free runner.
   */
  z.object({ status: z.literal("queued"), position: z.number().int().min(1) }),
  /** The first claim's time: a re-claim after a recovery keeps it. */
  z.object({ status: z.literal("running"), startedAt: z.iso.datetime() }),
  /**
   * A `visitor` run whose keys the server or the runner lost; it resumes when
   * they're resent. `startedAt` is null if it was never claimed.
   */
  z.object({ status: z.literal("awaiting-keys"), startedAt: z.iso.datetime().nullable() }),
  z.object({
    status: z.literal("ended"),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    /** Null when a queued run was cancelled before it started. */
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime(),
    /** Why a `failed` run failed; absent otherwise. */
    error: z.string().optional(),
  }),
]);
export type RunState = z.infer<typeof runStateSchema>;

/** Output ids the user selected; at most 200, each once. */
const selectedOutputsSchema = z
  .array(segmentSchema)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, "duplicate output id");

export const runSchema = z.object({
  id: runIdSchema,
  labId: z.string(),
  startedBy: userIdSchema,
  /** The pins the server resolved from the request's `workflowId`, as in `r2.ts`'s `workflowSnapshotPrefix`. */
  workflows: z.array(workflowPinSchema).min(1),
  input: inputSchema,
  /**
   * The output ids the user selected ("What do you want measured?", `outputs.json`); the run
   * covers the tasks that produce them and the tasks those depend on. Absent: every output.
   */
  selectedOutputs: selectedOutputsSchema.optional(),
  /** Free text the user added at the start; the workflow's main thread reads it. */
  notes: z.string().max(4000).optional(),
  /** Who pays for models and sandboxes; see the header. */
  credentials: z.enum(["voluma", "visitor"]),
  /**
   * A shared, read-only run every caller in the org can read, even under
   * `self`, set only by seeding (see the header). It always reads its org's
   * reference scan.
   */
  example: z.boolean(),
  /** The example run this one was forked from by a correction on it; null for a fresh run. */
  forkedFrom: runIdSchema.nullable(),
  createdAt: z.iso.datetime(),
  state: runStateSchema,
});
export type Run = z.infer<typeof runSchema>;

/** Real keys are well under 512 characters; the cap bounds what the server holds in memory. */
const keyField = z.string().min(1).max(512);
/**
 * A visitor's own credentials: a Meta Model API key and a Modal token. Sent
 * only in requests, never returned; see the header.
 */
export const visitorKeysSchema = z.object({
  metaApiKey: keyField,
  modal: z.object({ tokenId: keyField, tokenSecret: keyField }),
});
export type VisitorKeys = z.infer<typeof visitorKeysSchema>;

export const startRunRequestSchema = z.object({
  workflowId: workflowIdSchema,
  inputId: inputIdSchema,
  /** As `runSchema.selectedOutputs`; an id the workflow's `outputs.json` lacks fails the run at start, with that message. */
  selectedOutputs: selectedOutputsSchema.min(1).optional(),
  notes: z.string().max(4000).optional(),
  /** Present: the run uses these (`credentials: "visitor"`) and skips the org's runs-at-once count. */
  keys: visitorKeysSchema.optional(),
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

export const listRunsResponseSchema = z.object({ runs: z.array(runSchema) });
export const listInputsResponseSchema = z.object({ inputs: z.array(inputSchema) });
export const resendKeysRequestSchema = z.object({ keys: visitorKeysSchema });
export type ResendKeysRequest = z.infer<typeof resendKeysRequestSchema>;

/** The object store's limit on one PUT (R2: 5 GB); a larger file can't be uploaded. */
export const MAX_UPLOAD_FILE_BYTES = 5_000_000_000;

/**
 * A file's path inside the uploaded folder, as `inputKey` stores it: relative, `/`
 * separated, no `.` or `..` segment, no empty segment, no backslash or control
 * character, at most 300 characters. The worker sees it at `/inputs/<path>`.
 */
export const uploadPathSchema = relativePathSchema.refine(
  (p) => p.length <= 300 && ![...p].some((ch) => ch === "\\" || ch < " " || ch === "\x7f"),
  { message: "must be at most 300 characters, with no backslash or control character" },
);

export const uploadFileSchema = z.object({
  path: uploadPathSchema,
  /** Bytes; the PUT must send exactly this many. */
  size: z.number().int().min(0).max(MAX_UPLOAD_FILE_BYTES),
});
export type UploadFile = z.infer<typeof uploadFileSchema>;

export const createUploadRequestSchema = z.object({
  /** Shown in the scan picker and on every run of it. */
  name: z.string().trim().min(1).max(200),
  /** Each path once. The server's own limits on count and total bytes are lower. */
  files: z
    .array(uploadFileSchema)
    .min(1)
    .max(10_000)
    .refine((files) => new Set(files.map((f) => f.path)).size === files.length, "duplicate path"),
});
export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

export const createUploadResponseSchema = z.object({
  inputId: inputIdSchema,
  /** One per requested file, in request order. */
  uploads: z.array(z.object({ path: uploadPathSchema, url: z.url() })),
  /** When the URLs stop working. Complete still works after it if every file is stored. */
  expiresAt: z.iso.datetime(),
});
export type CreateUploadResponse = z.infer<typeof createUploadResponseSchema>;

/** Complete's 409: the declared files that are not stored with their declared size. */
export const completeUploadConflictSchema = z.object({
  error: z.string(),
  missing: z.array(uploadPathSchema),
});
