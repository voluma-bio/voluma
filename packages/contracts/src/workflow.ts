/**
 * What a run takes from its workflow packages, for both lanes:
 *
 * - Identity: a run pins this repo and the workflow's directory (`path`, e.g.
 *   `workflows/mouse-oa`); the runner adds the commit its checkout was at to the
 *   pins in the run's first event. `r2.ts` has the keys of a run's snapshot of it.
 * - The plan: each task's instructions, declared outputs (a measurement's acceptance
 *   range), the workflow's own definition of "done", and the tasks each depends on, the
 *   graph staleness follows (`task-tools.ts`). `packages/workflow` builds it from the
 *   workflow's `tasks.json` and `outputs.json` for the outputs the run selected; the runtime
 *   records it in the run's first event (`revision.started`, `events.ts`), so the fold
 *   reads it from the log and never from the workflow.
 */
import { z } from "zod";
import { isObjectKind, taskIdSchema } from "./ids";
import { outputEntrySchema } from "./workflow-files";

// Lowercase and exactly 40 hex characters, so one commit has one key.
const part = z.string().regex(/^(?!\.+$)[a-z0-9._-]+$/);

export const workflowPinSchema = z.object({
  /** GitHub `owner/name`, lowercase: this repo. */
  repo: z
    .string()
    .refine(
      (r) => r.split("/").length === 2 && r.split("/").every((p) => part.safeParse(p).success),
      {
        message: "must be lowercase `owner/name`",
      },
    ),
  /**
   * The commit of the checkout the run's files came from. The run record pins only the
   * path (the API does not read the files); the runner adds its commit to the pins in the
   * run's first event.
   */
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  /** The package's root inside the repo when it is not the repo root (e.g. `workflows/mouse-oa`): lowercase segments, as in `repo`. */
  path: z
    .string()
    .refine((p) => p.split("/").every((s) => part.safeParse(s).success), {
      message: "must be a relative path of lowercase segments",
    })
    .optional(),
});
export type WorkflowPin = z.infer<typeof workflowPinSchema>;

/** A pin as the runner records it in a run's first event: the commit is known and required. */
export const recordedPinSchema = workflowPinSchema.extend({
  commit: z.string().regex(/^[0-9a-f]{40}$/),
});
export type RecordedPin = z.infer<typeof recordedPinSchema>;

const nonEmpty = z.string().min(1);

/** What only the file keeps (`task`, `region`, `sourceRef`, a measurement's `headline`) is out of the plan; `name` is optional there. */
const out = { task: true, region: true, sourceRef: true } as const;
const plus = { name: nonEmpty.optional(), required: z.boolean() };
const [measurement, score, structure, surface, annotation, volume, file] =
  outputEntrySchema.options;

/**
 * An output a task must (or may) report, by its `outputId`: its entry in `outputs.json`
 * (`workflow-files.ts` has the fields of each kind) plus `required`. The constraints are what a
 * reported output is checked against (`task-tools.ts`). `name` is the structure's title, which
 * a reported structure must match when set. A plan recorded before `on` existed reads as no links.
 */
export const declaredOutputSchema = z.preprocess(
  (v) =>
    typeof v === "object" &&
    v !== null &&
    "kind" in v &&
    (v.kind === "measurement" || v.kind === "score")
      ? { on: [], ...v }
      : v,
  z.discriminatedUnion("kind", [
    measurement.omit({ ...out, headline: true }).extend(plus),
    score.omit(out).extend(plus),
    structure.omit(out).extend(plus),
    surface.omit(out).extend(plus),
    annotation.omit(out).extend(plus),
    volume.omit(out).extend(plus),
    file.omit(out).extend(plus),
  ]),
);
export type DeclaredOutput = z.infer<typeof declaredOutputSchema>;

/** One task of the plan: from the workflow's `tasks.json`, or ad hoc (no outputs). */
export const planTaskSchema = z.object({
  id: taskIdSchema,
  /** Short plain-language name from the workflow's `tasks.json`; shown instead of the id when present. */
  title: nonEmpty.optional(),
  /** Tasks this one builds on; a redo of one of them makes this one stale. */
  dependsOn: z.array(taskIdSchema),
  /** The workflow's done criteria in its own words, shown to the worker and the check. */
  doneWhen: z.array(nonEmpty).optional(),
  /** What the worker is told to do for this task; may point at files in the workflow skill. */
  instructions: nonEmpty.optional(),
  outputs: z.array(declaredOutputSchema),
});
export type PlanTask = z.infer<typeof planTaskSchema>;

export const workflowPlanSchema = z
  .object({
    tasks: z.array(planTaskSchema),
  })
  .superRefine((plan, ctx) => {
    const dup = (path: (string | number)[], what: string) =>
      ctx.addIssue({ code: "custom", path, message: `duplicate ${what}` });
    const tasks = new Set<string>();
    // `on`, `context` and `grid` name bare output ids, so an object's id is unique in the plan.
    const objects = new Set<string>();
    plan.tasks.forEach((t, ti) => {
      if (tasks.has(t.id)) dup(["tasks", ti, "id"], `task id "${t.id}"`);
      tasks.add(t.id);
      const outputs = new Set<string>();
      t.outputs.forEach((o, oi) => {
        if (isObjectKind(o.kind)) {
          if (objects.has(o.id)) dup(["tasks", ti, "outputs", oi, "id"], `object id "${o.id}"`);
          objects.add(o.id);
        }
        if (o.kind === "measurement" && o.range && o.range[0] > o.range[1])
          ctx.addIssue({
            code: "custom",
            path: ["tasks", ti, "outputs", oi, "range"],
            message: "range must be [min, max] with min <= max",
          });
        if (outputs.has(o.id)) dup(["tasks", ti, "outputs", oi, "id"], `output id "${o.id}"`);
        outputs.add(o.id);
      });
    });
    plan.tasks.forEach((t, ti) => {
      t.dependsOn.forEach((d, di) => {
        if (!tasks.has(d))
          ctx.addIssue({
            code: "custom",
            path: ["tasks", ti, "dependsOn", di],
            message: `"${d}" is not a task in the plan`,
          });
      });
    });
    const deps = new Map(plan.tasks.map((t) => [t.id, t.dependsOn]));
    // Depth-first; a task met again while still on the path closes a cycle.
    const done = new Set<string>();
    const path: string[] = [];
    const visit = (id: string): string[] | undefined => {
      if (path.includes(id)) return [...path.slice(path.indexOf(id)), id];
      if (done.has(id)) return undefined;
      path.push(id);
      for (const d of deps.get(id) ?? []) {
        const cycle = visit(d);
        if (cycle) return cycle;
      }
      path.pop();
      done.add(id);
      return undefined;
    };
    for (const t of plan.tasks) {
      const cycle = visit(t.id);
      if (cycle) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks"],
          message: `dependency cycle: ${cycle.join(" → ")}`,
        });
        break;
      }
    }
  });
export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;
