/**
 * Studies, under `/api/run`: a study is a group of runs, one per scan, of one workflow. Every
 * run belongs to one (`runSchema.studyId`). A study of one is a study whose scan count is 1;
 * nothing marks it. The rules of `run.ts` (org scoping, limits, visitor keys) apply to every
 * call here.
 *
 *   POST /api/run/studies      body `createStudyRequestSchema` → 200 `studyDetailSchema`
 *                              (404: unknown `workflowId`, or a scan the caller can't read;
 *                              409: a scan still uploading, or the per-caller limit;
 *                              429: the other limits, see `run.ts`; 400: `start` names a
 *                              scan the study lacks, or a scan twice)
 *   GET  /api/run/studies      → 200 `listStudiesResponseSchema`, newest activity first
 *   GET  /api/run/studies/:id  `?outputs=a,b` → 200 `studyDetailSchema` (404 when absent
 *                              or unreadable)
 *
 * Creating a study stores it, its scans and one `queued` run for each `start` scan in one
 * transaction under the queue's lock. A refusal (a limit, a vault that is full) refuses the
 * whole call: no study is left behind. The scans not in `start` wait with no run
 * ("not started"); `POST /api/run/runs` (`startRunRequestSchema`) starts them later, one at
 * a time. The stored scan row is the confirmed one: nothing runs until the researcher
 * confirms intake.
 *
 * Reads. `readableStudies` is the run rule on the study: the org matches and, under scope
 * `self`, the caller created it or it is the seeded example. A study's runs are the ones
 * `GET /runs` would show the caller, so a `self` caller sees only the runs they started in
 * an example study.
 *
 * `values` and `toCheck` come from each scan's **newest completed run** only (`resultRunId`):
 * accepting a check needs the latest completed result, so a live run's items would answer 409.
 * `values` is keyed by output id (the `outputs.json` id, not the fold's `taskId/outputId`)
 * and holds only the ids the request's `outputs` names that the run reported; the API reads
 * no workflow files, so the client sends the bundle's `headline` ids.
 */
import { z } from "zod";
import { inputIdSchema, runIdSchema, segmentSchema, studyIdSchema, taskIdSchema } from "./ids";
import { measurementSchema } from "./review";
import {
  inputSchema,
  runSchema,
  selectedOutputsSchema,
  visitorKeysSchema,
  workflowIdSchema,
} from "./run";

const label = z.string().trim().min(1).max(200);

/** Workflow-specific sample fields (a knee's side); the study does not interpret them. */
const attributesSchema = z
  .record(z.string().min(1).max(100), z.union([z.string().max(500), z.number(), z.boolean()]))
  .refine((a) => Object.keys(a).length <= 50, "at most 50 attributes");

/** One scan of a study. `subject` is the specimen (a mouse id); the input's name when the caller gave none. */
export const studyScanSchema = z.object({
  inputId: inputIdSchema,
  subject: label,
  group: label.nullable(),
  attributes: attributesSchema,
  /** Order in the study, from 0. */
  position: z.number().int().nonnegative(),
});
export type StudyScan = z.infer<typeof studyScanSchema>;

export const studySchema = z.object({
  id: studyIdSchema,
  labId: z.string(),
  name: label,
  workflowId: workflowIdSchema,
  /** Shown, never enforced. */
  budgetUsd: z.number().nonnegative().nullable(),
  createdBy: z.string(),
  /** The seeded, read-only example's study. */
  example: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Study = z.infer<typeof studySchema>;

/** A row of Home's study table. Counts cover every run of the study. */
export const studySummarySchema = studySchema.extend({
  scanCount: z.number().int().nonnegative(),
  runCounts: z.object({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    awaitingKeys: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  /** Open checks of each scan's newest completed run, summed. */
  toCheck: z.number().int().nonnegative(),
  /** The latest of the study's creation and its runs' creation, start and end. */
  lastActivityAt: z.iso.datetime(),
});
export type StudySummary = z.infer<typeof studySummarySchema>;
export const listStudiesResponseSchema = z.object({ studies: z.array(studySummarySchema) });

/** What a headline needs from a reported measurement. */
export const studyValueSchema = measurementSchema.pick({
  value: true,
  unit: true,
  confidence: true,
});
export type StudyValue = z.infer<typeof studyValueSchema>;

/** An open check of a run's latest result. */
export const toCheckItemSchema = z.object({
  runId: runIdSchema,
  taskId: taskIdSchema,
  checkId: z.string().min(1),
  title: z.string(),
});
export type ToCheckItem = z.infer<typeof toCheckItemSchema>;

export const studyScanDetailSchema = z.object({
  scan: studyScanSchema,
  input: inputSchema,
  /** Newest first; empty: "not started". */
  runs: z.array(runSchema),
  /** The newest completed run, which `values` and `toCheck` read; null when none has completed. */
  resultRunId: runIdSchema.nullable(),
  /** Output id → value, for the requested outputs that run reported. */
  values: z.record(segmentSchema, studyValueSchema),
  toCheck: z.array(toCheckItemSchema),
});
export type StudyScanDetail = z.infer<typeof studyScanDetailSchema>;

export const studyDetailSchema = z.object({
  study: studySchema,
  /** In study order. */
  scans: z.array(studyScanDetailSchema),
});
export type StudyDetail = z.infer<typeof studyDetailSchema>;

/** `?outputs=` of the detail read: at most 200 ids, comma separated. */
export const studyOutputsQuerySchema = selectedOutputsSchema;

export const createStudyRequestSchema = z
  .object({
    name: label,
    workflowId: workflowIdSchema,
    /** Each input once; every one must be readable by the caller and complete. */
    scans: z
      .array(
        z.object({
          inputId: inputIdSchema,
          subject: label.optional(),
          group: label.optional(),
          attributes: attributesSchema.optional(),
        }),
      )
      .min(1)
      .max(200),
    /** The scans to run now, a subset of `scans`; the rest wait. May be empty. */
    start: z.array(inputIdSchema),
    budgetUsd: z.number().nonnegative().optional(),
    /** For every run started by this call, as in `startRunRequestSchema`. */
    selectedOutputs: selectedOutputsSchema.min(1).optional(),
    notes: z.string().max(4000).optional(),
    /** Present: these runs use these (`credentials: "visitor"`). */
    keys: visitorKeysSchema.optional(),
  })
  .refine((r) => new Set(r.scans.map((s) => s.inputId)).size === r.scans.length, {
    path: ["scans"],
    message: "a scan appears twice",
  })
  .refine((r) => new Set(r.start).size === r.start.length, {
    path: ["start"],
    message: "a scan appears twice",
  })
  .refine((r) => r.start.every((id) => r.scans.some((s) => s.inputId === id)), {
    path: ["start"],
    message: "start names a scan the study lacks",
  });
export type CreateStudyRequest = z.infer<typeof createStudyRequestSchema>;
