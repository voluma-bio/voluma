/**
 * What a run takes from its workflow packages, for both lanes:
 *
 * - Identity: a package on GitHub pinned to a commit. A run is pinned to
 *   several (the OA workflow plus `microct-analysis`), so pins are always an
 *   array. `r2.ts` turns a pin into its key prefix.
 * - The plan: each task's declared outputs, the workflow's own definition of
 *   "done". `packages/workflow` parses `workflow.md` into it; the runtime
 *   records it in the run's first event (`revision.started`, `events.ts`), so
 *   the fold reads it from the log and never from the workflow.
 */
import { z } from "zod";
import { segmentSchema, taskIdSchema } from "./ids";

// Lowercase and exactly 40 hex characters, so one commit has one key.
const part = z.string().regex(/^(?!\.+$)[a-z0-9._-]+$/);

export const workflowPinSchema = z.object({
  /** GitHub `owner/name`, lowercase. */
  repo: z
    .string()
    .refine(
      (r) => r.split("/").length === 2 && r.split("/").every((p) => part.safeParse(p).success),
      {
        message: "must be lowercase `owner/name`",
      },
    ),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
});
export type WorkflowPin = z.infer<typeof workflowPinSchema>;

const nonEmpty = z.string().min(1);
const declaredBase = { id: segmentSchema, required: z.boolean() };

/**
 * An output a task must (or may) report, by its `outputId`. The constraints
 * are what a reported output is checked against (`task-tools.ts`).
 */
export const declaredOutputSchema = z.discriminatedUnion("kind", [
  z.object({ ...declaredBase, kind: z.literal("measurement"), unit: nonEmpty }),
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
    tasks: z.array(z.object({ id: taskIdSchema, outputs: z.array(declaredOutputSchema) })),
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
        if (outputs.has(o.id)) dup(["tasks", ti, "outputs", oi, "id"], `output id "${o.id}"`);
        outputs.add(o.id);
      });
    });
  });
export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;
