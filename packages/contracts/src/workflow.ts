/**
 * Workflow identity: a package on GitHub pinned to a commit. A run is pinned
 * to several (the OA workflow plus `microct-analysis`), so pins are always an
 * array. `r2.ts` turns a pin into its key prefix.
 */
import { z } from "zod";

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
