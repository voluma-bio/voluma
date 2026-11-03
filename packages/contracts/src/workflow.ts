/**
 * What a run takes from its workflow packages: it pins this repo and the workflow's directory (`path`, e.g.
 *   `workflows/mouse-oa`); the runner adds the commit its checkout was at to the
 *   pins in the run's first event. `r2.ts` has the keys of a run's snapshot of it.
 */
import { z } from "zod";

// One lowercase path segment of `owner/name`.
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
