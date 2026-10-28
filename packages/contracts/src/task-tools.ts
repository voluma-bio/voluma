/**
 * The tools that write `task`, `checkpoint` and `value` events (`events.ts`,
 * which also holds the fold the run screen and review read them by).
 *
 * `checklist` and `report_value` are the worker's (`checkpoint` is the worker's
 * and a check thread's); the supervisor's own checklist calls use `checklist`
 * too. The runtime enforces who may set what: a worker sets only `in-progress`,
 * `done`, `failed` and `to-check`; `under-review` and `stale` are the
 * supervisor's or the runtime's; only a check thread sets `verdict`; nobody
 * writes to a task under review but its check thread. These schemas only shape
 * the call.
 *
 * Evidence is named by path under the task's output folder. On success the
 * runtime copies each file to its `evidenceKey` and appends the event with
 * `{name, sha256}`; a missing file fails the call and appends nothing. Results
 * reach the record as `tool.result.output`, the object as JSON.
 */
import { z } from "zod";
import { evidenceRefSchema, taskStatusSchema } from "./events";
import { relativePathSchema, taskIdSchema } from "./r2";

const nonEmpty = z.string().min(1);

const evidencePaths = z
  .array(relativePathSchema)
  .describe("Files under this task's output folder that the line rests on.");

export const checklistInputSchema = z.object({
  taskId: taskIdSchema,
  status: taskStatusSchema,
  reason: nonEmpty.describe("One plain-language line: why the task is in this state."),
});
export type ChecklistInput = z.infer<typeof checklistInputSchema>;

export const checklistResultSchema = z.object({ status: taskStatusSchema });
export type ChecklistResult = z.infer<typeof checklistResultSchema>;

export const checkpointInputSchema = z.object({
  taskId: taskIdSchema,
  text: nonEmpty.describe(
    "A milestone in plain language, e.g. 'Width on the plane square to the shaft: 3.39 mm.'",
  ),
  evidence: evidencePaths,
  verdict: z
    .enum(["passed", "needs-review"])
    .optional()
    .describe("Check threads only: your verdict on the task. Put it on one line."),
  toCheck: z
    .object({ title: nonEmpty.describe("What the reviewer should look at, in a few words.") })
    .optional()
    .describe("Set when you are unsure of something; `text` explains it. The run doesn't stop."),
});
export type CheckpointInput = z.infer<typeof checkpointInputSchema>;

export const checkpointResultSchema = z.object({ evidence: z.array(evidenceRefSchema) });
export type CheckpointResult = z.infer<typeof checkpointResultSchema>;

export const reportValueInputSchema = z.object({
  taskId: taskIdSchema,
  measurementId: nonEmpty.describe(
    "Stable name for this quantity; reuse it when you redo the task.",
  ),
  title: nonEmpty,
  value: z
    .number()
    .finite()
    .nullable()
    .describe("Null if it could not be computed; explain in note."),
  unit: nonEmpty.describe("`mm`, `mm^3`, `1/mm`; `1` for a ratio or a count."),
  confidence: z.enum(["provisional", "candidate"]).nullable(),
  note: z.string().optional(),
  definition: z.string().optional(),
  evidence: evidencePaths,
  structureIds: z
    .array(nonEmpty)
    .default([])
    .describe("Structures it was counted from or drawn on."),
  annotationIds: z.array(nonEmpty).default([]).describe("Annotations that show it."),
  numeratorId: nonEmpty.optional(),
  denominatorId: nonEmpty.optional(),
});
export type ReportValueInput = z.infer<typeof reportValueInputSchema>;

export const reportValueResultSchema = z.object({ evidence: z.array(evidenceRefSchema) });
export type ReportValueResult = z.infer<typeof reportValueResultSchema>;
