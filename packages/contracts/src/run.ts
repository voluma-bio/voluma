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
 *                                  server's limits; 429 when the caller already has as
 *                                  many uploads open as the server allows
 *   POST /api/run/inputs/:id/complete → 200 `inputSchema` once every declared file is
 *                                  stored with its declared size; 409
 *                                  `completeUploadConflictSchema` listing the files that
 *                                  aren't; completing a completed upload is a no-op, and
 *                                  a retried complete finishes one that failed part way;
 *                                  404 unless the caller is the uploader
 *   POST /api/run/inputs/:id/cancel → 204: drops an uncompleted upload and its stored
 *                                  files, freeing its place under the open-upload limit;
 *                                  404 unless the caller is the uploader; 409 once
 *                                  completed (a completed scan is not deleted here)
 *
 * Uploads. A scan's files never pass through the API: the server answers a create
 * with a presigned `PUT` URL per file, straight to object storage, valid until
 * `expiresAt` (at least 6 h after the create). The client PUTs each file's bytes with
 * `Content-Length` equal to the declared `size` and no other required header (no
 * `Content-Type` is signed, so any or none may be sent); the server signs
 * `content-length` into each URL, so storage refuses a body of any other length. A
 * failed PUT is retried by PUTting the file again to the same URL. Then the client calls
 * complete: the server checks every declared file is stored at its declared size and
 * moves the files to the input's own prefix (`inputKey` in `r2.ts`), which no URL can
 * write. The URLs write only to the upload's staging prefix (`uploadKey`), so a URL
 * used after complete changes nothing a run reads. After `expiresAt` an upload that was
 * not completed can't be finished by new PUTs; create a new one. The server may delete an
 * uncompleted upload and its files any time after `expiresAt`.
 *
 * Until complete succeeds the input is its uploader's alone: it isn't listed, complete
 * and `startRun` answer 404 to everyone else, and `startRun` answers 409 to the uploader.
 * Once complete, it is read like any input (scoping below): under scope `self` only the
 * uploader lists and starts on it, under `lab` the whole org does. One PUT per file, no
 * multipart: a file is at most `MAX_UPLOAD_FILE_BYTES`, the object store's single-PUT
 * limit; a scan is a folder of slices, or one volume of a few GB at most, so a retry
 * re-sends one file. Creating an upload needs a member account (judges included; a guest
 * gets 403). The server limits files and bytes per upload, and how many uncompleted,
 * unexpired uploads a member may have open.
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
 *     from the usage the runner reports with its heartbeats (`runner.ts`), whose
 *     sum the run record shows as `usage`. The daily and dollar limits answer
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
  /**
   * What the run has spent so far: the sum of the usage its heartbeats reported (`runner.ts`).
   * `modelCostUsd` is model calls and paid tool calls (`tool.result.costUsd`), in US dollars;
   * `sandboxSeconds` is how long its sandbox was up. Per task: `spend` in `spend.ts`.
   * Optional until the API writes it, as is `toCheck`.
   */
  usage: z
    .object({
      modelCostUsd: z.number().nonnegative(),
      sandboxSeconds: z.number().nonnegative(),
    })
    .optional(),
  /**
   * The open To check items when the run last completed, counted by `fold` over its whole
   * log; null while it runs, and when it ended failed or cancelled (a failed run's items are
   * still in its review). Set each time the run completes; the review lane owns what happens
   * to the items between.
   */
  toCheck: z.number().int().nonnegative().nullable().optional(),
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
 * Control, format (bidi marks, zero-width characters) and line or paragraph separator
 * characters, which are invisible in the picker and can disguise a name; and a lone
 * surrogate, which no URL or object key can hold.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/**
 * A file's path inside the uploaded folder, as `inputKey` stores it: relative, `/`
 * separated, no `.` or `..` segment, no empty segment, no backslash or invisible
 * character (control, format, line or paragraph separator), well-formed Unicode in NFC,
 * at most 300 characters. The worker sees it at `/inputs/<path>`.
 */
export const uploadPathSchema = relativePathSchema.refine(
  (p) => p.length <= 300 && p === p.normalize("NFC") && !p.includes("\\") && !UNSAFE.test(p),
  {
    message:
      "must be well-formed NFC, at most 300 characters, with no backslash or invisible character",
  },
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
  /**
   * Each path once, and no path is also a folder of another (`a` and `a/b`): a mounted
   * folder can't hold both. The server's own limits on count and total bytes are lower.
   */
  files: z
    .array(uploadFileSchema)
    .min(1)
    .max(10_000)
    .refine((files) => new Set(files.map((f) => f.path)).size === files.length, "duplicate path")
    .refine((files) => {
      const paths = new Set(files.map((f) => f.path));
      return files.every((f) =>
        f.path
          .split("/")
          .slice(0, -1)
          .every((_, i, dirs) => !paths.has(dirs.slice(0, i + 1).join("/"))),
      );
    }, "a path is also another path's folder"),
});
export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

export const createUploadResponseSchema = z.object({
  inputId: inputIdSchema,
  /** One per requested file, in request order. */
  uploads: z.array(z.object({ path: uploadPathSchema, url: z.url() })),
  /** When the URLs stop working; see Uploads. */
  expiresAt: z.iso.datetime(),
});
export type CreateUploadResponse = z.infer<typeof createUploadResponseSchema>;

/** Complete's 409: the declared files that are not stored with their declared size. */
export const completeUploadConflictSchema = z.object({
  error: z.string(),
  missing: z.array(uploadPathSchema),
});
