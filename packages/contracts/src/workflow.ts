/**
 * What a run takes from its workflow packages, for both lanes:
 *
 * - Identity: a run pins this repo and the workflow's directory (`path`, e.g.
 *   `workflows/workflow-mouse-oa`); the runner adds the commit its checkout was at to the
 *   pins in the run's first event. `r2.ts` has the keys of a run's snapshot of it.
 * - The plan: each task's instructions, declared outputs (a measurement's acceptance
 *   range), the workflow's own definition of "done", and the tasks each depends on, the
 *   graph staleness follows (`task-tools.ts`). `packages/workflow` builds it from the
 *   workflow's `tasks.json` and `outputs.json` for the outputs the run selected; the runtime
 *   records it in the run's first event (`revision.started`, `events.ts`), so the fold
 *   reads it from the log and never from the workflow.
 */
import { z } from "zod";
import { segmentSchema, taskIdSchema } from "./ids";

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
  /** The package's root inside the repo when it is not the repo root (e.g. `workflows/workflow-mouse-oa`): lowercase segments, as in `repo`. */
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
const declaredBase = { id: segmentSchema, required: z.boolean() };

/**
 * An output a task must (or may) report, by its `outputId`. The constraints
 * are what a reported output is checked against (`task-tools.ts`).
 */
export const declaredOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    ...declaredBase,
    kind: z.literal("measurement"),
    unit: nonEmpty,
    /** Acceptance range `[min, max]` in `unit`: advice for the reviewer and the review screen, never a refusal. */
    range: z.tuple([z.number(), z.number()]).optional(),
  }),
  /** The scale, lowest first: a reported level must be one of these. */
  z.object({ ...declaredBase, kind: z.literal("score"), levels: z.array(nonEmpty).min(2) }),
  /** `label` is the value in the labels volume and `name` the structure's title; each, when set, must match. */
  z.object({
    ...declaredBase,
    kind: z.literal("structure"),
    label: z.number().int().positive().optional(),
    name: nonEmpty.optional(),
  }),
  z.object({ ...declaredBase, kind: z.literal("annotation"), shape: z.enum(["point", "line"]) }),
  /** `labels` holds structures' label values; a structure's `volume` must be one. */
  z.object({
    ...declaredBase,
    kind: z.literal("volume"),
    volumeKind: z.enum(["image", "labels"]),
  }),
  z.object({ ...declaredBase, kind: z.literal("file"), mediaType: nonEmpty }),
]);
export type DeclaredOutput = z.infer<typeof declaredOutputSchema>;

export const workflowPlanSchema = z
  .object({
    tasks: z.array(
      z.object({
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
      }),
    ),
  })
  .superRefine((plan, ctx) => {
    const dup = (path: (string | number)[], what: string) =>
      ctx.addIssue({ code: "custom", path, message: `duplicate ${what}` });
    const tasks = new Set<string>();
    plan.tasks.forEach((t, ti) => {
      if (tasks.has(t.id)) dup(["tasks", ti, "id"], `task id "${t.id}"`);
      tasks.add(t.id);
      const outputs = new Set<string>();
      t.outputs.forEach((o, oi) => {
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
