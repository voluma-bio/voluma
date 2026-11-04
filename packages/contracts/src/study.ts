/**
 * Studies, under `/api/run`: a study is a group of runs, one per input, of one workflow. Every
 * run belongs to one (`runSchema.studyId`). A study of one is a study whose input count is 1;
 * nothing marks it. The rules of `run.ts` (org scoping, limits, visitor keys) apply to every
 * call here.
 *
 *   POST /api/run/studies      body `createStudyRequestSchema` → 200 `studyDetailSchema`
 *                              (404: unknown `workflowId`, or an input the caller can't read;
 *                              409: an input still uploading;
 *                              429: the other limits, see `run.ts`; 400: `start` names a
 *                              input the study lacks, an input twice, or `selectedOutputs` names an
 *                              output that is not a selectable output of the workflow)
 *   GET  /api/run/studies      → 200 `listStudiesResponseSchema`, newest activity first
 *   GET  /api/run/studies/:id  → 200 `studyDetailSchema` (404 when absent or unreadable)
 *
 * Creating a study stores it, its inputs and one `queued` run for each `start` input in one
 * transaction under the queue's lock. A refusal (a limit, 100 unfinished own-key runs over all accounts) refuses the
 * whole call: no study is left behind. The inputs not in `start` wait with no run
 * ("not started"); `POST /api/run/runs` (`startRunRequestSchema`) starts them later, one at
 * a time. The stored input row is the confirmed one: nothing runs until the researcher
 * confirms intake.
 *
 * Reads. `readableStudies` is the run rule on the study: the org matches and the caller
 * created it or it is the seeded example. A study's runs are the ones `GET /runs` would
 * show the caller, so they see only the runs they started in an example study.
 *
 * `needsYou` is the open To check items a person can answer, what every screen calls To check
 * (`OutputsFold.toCheck`). `values` come from each input's **newest completed run** only
 * (`resultRunId`): every final value's latest number, its UCUM unit written as people write it
 * (`unitAsWritten`), keyed by output id. `outputStatus` is each final output's status in the
 * newest run, whatever its state, so the study shows where a live or stopped run is.
 *
 * The list is what Home renders: per study its counts and each input's newest run in brief
 * (`studyRunSummarySchema`), so Home reads no run list.
 */
import { z } from "zod";
import { inputIdSchema, modelRefSchema, runIdSchema, segmentSchema, studyIdSchema } from "./ids";
import type { OutputStatus } from "./output-fold";
import {
  inputSchema,
  runOutputsInSchema,
  runSchema,
  runStateSchema,
  runThinkingSchema,
  selectedOutputsSchema,
  visitorKeysSchema,
  workflowIdSchema,
} from "./run";

const label = z.string().trim().min(1).max(200);

/** Workflow-specific sample fields (a knee's side); the study does not interpret them. */
const attributesSchema = z
  .record(z.string().min(1).max(100), z.union([z.string().max(500), z.number(), z.boolean()]))
  .refine((a) => Object.keys(a).length <= 50, "at most 50 attributes");

/** The study's row for one of its inputs. `subject` is the specimen (a mouse id); the input's name when the caller gave none. */
export const studyMemberSchema = z.object({
  inputId: inputIdSchema,
  subject: label,
  group: label.nullable(),
  attributes: attributesSchema,
});
export type StudyMember = z.infer<typeof studyMemberSchema>;

export const studySchema = z.object({
  id: studyIdSchema,
  name: label,
  workflowId: workflowIdSchema,
  /**
   * Model dollars a run of the study may spend. The runner enforces it per run (earlier claims
   * included) as min(budgetUsd, RUNNER_MAX_RUN_COST_USD), failing the run past it; null: the
   * runner's ceiling alone (`claimSchema.budgetUsd`).
   */
  budgetUsd: z.number().nonnegative().nullable(),
  /** The seeded, read-only example's study. */
  example: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Study = z.infer<typeof studySchema>;

/** A completed run's review in brief: the open To check items on its final outputs and what they rest on (`OutputsFold.toCheck`). Null for a run that has not completed. */
export const runReviewBriefSchema = z
  .object({ needsYou: z.number().int().nonnegative() })
  .nullable();

/** As `OutputStatus` (`output-fold.ts`): a final output's status in a run. */
export const outputStatusSchema = z.enum([
  "pending",
  "reported",
  "to-check",
  "missing",
  "out-of-date",
]) satisfies z.ZodType<OutputStatus>;

/**
 * The calls main holds for this run's answer (`openApprovals`, agents.ts) that the caller can
 * answer: 0 unless the caller is the run's starter on a run that takes their messages
 * (`runReadSchema.cannotMessage` is null). The sample page reads "Waiting on you" from the same rule.
 */
const waitingSchema = z.number().int().nonnegative();

/** An input's newest run in brief, whatever its state: what Home shows of a study. */
export const studyRunSummarySchema = z.object({
  runId: runIdSchema,
  inputId: inputIdSchema,
  inputName: z.string(),
  /** As `runSchema.state`: the queue position of a queued run, the `error` of a failed one. */
  state: runStateSchema,
  /** As `runSchema.outputs`: a live run's final outputs in, of all of them. */
  outputs: runOutputsInSchema,
  review: runReviewBriefSchema,
  waiting: waitingSchema,
  example: z.boolean(),
});
export type StudyRunSummary = z.infer<typeof studyRunSummarySchema>;

/** A row of Home's study list. */
export const studySummarySchema = studySchema.extend({
  inputCount: z.number().int().nonnegative(),
  /** Inputs with a completed run, whether or not it is the newest. */
  inputsCompleted: z.number().int().nonnegative(),
  /** The latest of the study's creation and its runs' creation, start and end. */
  lastActivityAt: z.iso.datetime(),
  /** Each input's newest run, newest first; an input with no run is absent. */
  newestRuns: z.array(studyRunSummarySchema),
});
export type StudySummary = z.infer<typeof studySummarySchema>;
export const listStudiesResponseSchema = z.object({ studies: z.array(studySummarySchema) });

/** What a headline needs from a final value. */
export const studyValueSchema = z.object({
  value: z.number().finite().nullable(),
  unit: z.string(),
});

export const studyInputDetailSchema = z.object({
  member: studyMemberSchema,
  input: inputSchema,
  /** Newest first; empty: "not started". */
  runs: z.array(runSchema),
  /** The newest run's review in brief (`runReviewBriefSchema`). */
  review: runReviewBriefSchema,
  /** The newest run's `waiting` (`studyRunSummarySchema`); 0 without a run. */
  waiting: waitingSchema,
  /** Final output id → its status in the newest run; empty before main lists its outputs. */
  outputStatus: z.record(segmentSchema, outputStatusSchema),
  /** The newest completed run, which `values` reads; null when none has completed. */
  resultRunId: runIdSchema.nullable(),
  /** Output id → its latest number, for every final value that run reported. */
  values: z.record(segmentSchema, studyValueSchema),
});
export type StudyInputDetail = z.infer<typeof studyInputDetailSchema>;

export const studyDetailSchema = z.object({
  study: studySchema,
  /** In study order. */
  inputs: z.array(studyInputDetailSchema),
});
export type StudyDetail = z.infer<typeof studyDetailSchema>;

// Delete the `scans` alias with its TODO (apps/api/.context/TODO.md): a /new tab opened before the
// rename posts `scans`, and must not fail for the rest of the deploy overlap.
const scansAsInputs = (body: unknown) =>
  typeof body === "object" && body !== null && "scans" in body && !("inputs" in body)
    ? { ...body, inputs: body.scans }
    : body;

export const createStudyRequestSchema = z.preprocess(
  scansAsInputs,
  z
    .object({
      name: label,
      workflowId: workflowIdSchema,
      /** Each input once; every one must be readable by the caller and complete. */
      inputs: z
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
      /** The inputs to run now, a subset of `inputs`; the rest wait. May be empty. */
      start: z.array(inputIdSchema),
      budgetUsd: z.number().nonnegative().optional(),
      /** For every run started by this call, as in `startRunRequestSchema`. */
      selectedOutputs: selectedOutputsSchema.min(1).optional(),
      notes: z.string().max(4000).optional(),
      /** Present: these runs use these (`credentials: "visitor"`). */
      keys: visitorKeysSchema.optional(),
      /** For every run started by this call, as in `startRunRequestSchema`. */
      model: modelRefSchema.optional(),
      /** For every run started by this call, as in `startRunRequestSchema`. */
      thinking: runThinkingSchema.optional(),
    })
    .refine((r) => new Set(r.inputs.map((s) => s.inputId)).size === r.inputs.length, {
      path: ["inputs"],
      message: "an input appears twice",
    })
    .refine((r) => new Set(r.start).size === r.start.length, {
      path: ["start"],
      message: "an input appears twice",
    })
    .refine((r) => r.start.every((id) => r.inputs.some((s) => s.inputId === id)), {
      path: ["start"],
      message: "start names an input the study lacks",
    }),
);
export type CreateStudyRequest = z.infer<typeof createStudyRequestSchema>;
