/**
 * The two data files of a workflow skill (`workflows/<name>/`), written by people and
 * read by `packages/workflow`:
 *
 * - `outputs.json`: every output a run of the workflow can produce. The run screen lists
 *   these as "What do you want measured?"; a run starts with the ids the user selected
 *   (`startRunRequestSchema`).
 * - `tasks.json`: the canonical task list. A task names the outputs it produces by id, so
 *   units, ranges and labels live once, in `outputs.json`.
 *
 * Both are strict: an unknown key or a dangling id fails with the path to it. Every reference
 * a review needs is in `outputs.json`: a measurement or score names the objects it was measured
 * on (`on`) and what is drawn around it (`context`); a structure, surface or annotation names
 * its grid. Each must be produced by the same task or one it builds on, transitively, so a
 * redo upstream also makes the measurement stale. `packages/workflow`
 * turns them into the run's `WorkflowPlan` (`workflow.ts`) for the outputs a run selected.
 * `outputsFileJsonSchema` and `tasksFileJsonSchema` are JSON Schemas for editor autocomplete.
 * Both files are arrays, which cannot carry a `"$schema"` key, so map them in the editor
 * instead (VS Code `json.schemas`, matching each workflow directory's `outputs.json` and `tasks.json`).
 */
import { z } from "zod";
import { isObjectKind, segmentSchema, taskIdSchema } from "./ids";

const nonEmpty = z.string().min(1);

/**
 * Ids of objects (`volume`, `structure`, `surface`, `annotation`) a measurement or score is shown with.
 * `on` is a required key so each states its links; `[]` is a deliberate "nothing to show it on".
 */
const links = {
  /** Highlighted with the value. */
  on: z.array(segmentSchema),
  /** Drawn around it. */
  context: z.array(segmentSchema).optional(),
};

/** The `volume` output an object's voxels are on. */
const grid = { grid: segmentSchema };

const entryBase = {
  id: segmentSchema,
  /** The label people see. */
  name: nonEmpty,
  /** Plain-text definition of what is measured and where, for the worker and the review screen. */
  region: z.string().optional(),
  /** The task that produces it. */
  task: taskIdSchema,
  /** Where the expected value or definition comes from, e.g. the lab deck's number. */
  sourceRef: z.string().optional(),
};

/**
 * One output a run can produce, by the kind it reports (`output.ts`). The kind-specific
 * fields are those of `declaredOutputSchema` (`workflow.ts`); a structure's `name` is the entry's.
 */
export const outputEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...entryBase,
    kind: z.literal("measurement"),
    ...links,
    unit: nonEmpty,
    /** Acceptance range `[min, max]` in `unit`; advice for the check and the review screen. */
    range: z
      .tuple([z.number(), z.number()])
      .refine(([min, max]) => min <= max, "range must be [min, max] with min <= max")
      .optional(),
    /** The study page plots this measurement for every scan; the web asks for the `headline` ids (`StudyDetail`). */
    headline: z.boolean().optional(),
  }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("score"),
    ...links,
    levels: z.array(nonEmpty).min(2),
  }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("structure"),
    ...grid,
    /** The value in the grid, which is then a `labels` volume; absent: the structure is a cropped mask on the grid. */
    label: z.number().int().positive().optional(),
  }),
  z.strictObject({ ...entryBase, kind: z.literal("surface"), ...grid }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("annotation"),
    ...grid,
    shape: z.enum(["point", "line"]),
  }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("volume"),
    volumeKind: z.enum(["image", "labels"]),
  }),
  z.strictObject({ ...entryBase, kind: z.literal("file"), mediaType: nonEmpty }),
]);
export type OutputEntry = z.infer<typeof outputEntrySchema>;

/** Only measurements and scores can be selected for a run; objects follow from the tasks that produce them. */
export const isSelectable = (entry: OutputEntry) =>
  entry.kind === "measurement" || entry.kind === "score";

export const taskEntrySchema = z.strictObject({
  id: taskIdSchema,
  /** Short plain-language name for people ("Scan intake"); the id stays the identity. */
  title: nonEmpty.optional(),
  /** Tasks this one builds on; a redo of one of them makes this one stale. */
  dependsOn: z.array(taskIdSchema),
  /** Ids from `outputs.json` this task produces. */
  outputs: z.array(segmentSchema),
  /** What the worker is told to do; may point at files under the skill's `references/`. */
  instructions: nonEmpty,
  /** Done criteria, shown to the worker and the check. */
  doneWhen: z.array(nonEmpty),
});
export type TaskEntry = z.infer<typeof taskEntrySchema>;

export const outputsFileSchema = z.array(outputEntrySchema);
export const tasksFileSchema = z.array(taskEntrySchema);

/**
 * The two files together: ids are unique, every output names a task that lists it back, every
 * task lists only outputs that exist and name it, and `dependsOn` names tasks of the file.
 * Cycles are caught when the plan is built (`workflowPlanSchema`).
 */
export const workflowFilesSchema = z
  .object({ outputs: outputsFileSchema, tasks: tasksFileSchema })
  .superRefine(({ outputs, tasks }, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const seen = (ids: string[], file: string) =>
      ids.forEach((id, i) => {
        if (ids.indexOf(id) !== i) issue([file, i, "id"], `duplicate id "${id}"`);
      });
    seen(
      outputs.map((o) => o.id),
      "outputs",
    );
    seen(
      tasks.map((t) => t.id),
      "tasks",
    );
    const taskIds = new Set(tasks.map((t) => t.id));
    const byId = new Map(outputs.map((o) => [o.id, o]));
    outputs.forEach((o, i) => {
      if (!taskIds.has(o.task)) issue(["outputs", i, "task"], `"${o.task}" is not a task`);
      else if (!tasks.find((t) => t.id === o.task)?.outputs.includes(o.id)) {
        issue(["outputs", i, "task"], `task "${o.task}" does not list output "${o.id}"`);
      }
    });
    const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]));
    const upstream = (id: string, seenTasks = new Set<string>()): Set<string> => {
      for (const d of deps.get(id) ?? []) {
        if (!seenTasks.has(d)) {
          seenTasks.add(d);
          upstream(d, seenTasks);
        }
      }
      return seenTasks;
    };
    outputs.forEach((o, i) => {
      const refs: [field: string, ids: string[]][] =
        o.kind === "measurement" || o.kind === "score"
          ? [
              ["on", o.on],
              ["context", o.context ?? []],
            ]
          : o.kind === "structure" || o.kind === "surface" || o.kind === "annotation"
            ? [["grid", [o.grid]]]
            : [];
      for (const [field, ids] of refs) {
        for (const [j, id] of ids.entries()) {
          const at = field === "grid" ? ["outputs", i, field] : ["outputs", i, field, j];
          const target = byId.get(id);
          const problem = !target
            ? `"${id}" is not in outputs.json`
            : (field === "grid" ? target.kind !== "volume" : !isObjectKind(target.kind))
              ? `"${id}" is a ${target.kind}, not ${field === "grid" ? "a volume" : "an object"}`
              : target.task !== o.task && !upstream(o.task).has(target.task)
                ? `"${id}" is produced by task "${target.task}", which "${o.task}" does not build on`
                : o.kind === "structure" &&
                    o.label !== undefined &&
                    target.kind === "volume" &&
                    target.volumeKind !== "labels"
                  ? `"${id}" holds the label of "${o.id}", so it must be a labels volume`
                  : undefined;
          if (problem) issue(at, problem);
        }
      }
    });
    tasks.forEach((t, i) => {
      t.dependsOn.forEach((d, j) => {
        if (!taskIds.has(d)) issue(["tasks", i, "dependsOn", j], `"${d}" is not a task`);
      });
      t.outputs.forEach((id, j) => {
        if (t.outputs.indexOf(id) !== j)
          issue(["tasks", i, "outputs", j], `duplicate output "${id}"`);
        const o = byId.get(id);
        if (!o) issue(["tasks", i, "outputs", j], `"${id}" is not in outputs.json`);
        else if (o.task !== t.id) {
          issue(
            ["tasks", i, "outputs", j],
            `"${id}" is produced by task "${o.task}", not "${t.id}"`,
          );
        }
      });
    });
  });
export type WorkflowFiles = z.infer<typeof workflowFilesSchema>;

export const outputsFileJsonSchema = z.toJSONSchema(outputsFileSchema);
export const tasksFileJsonSchema = z.toJSONSchema(tasksFileSchema);
