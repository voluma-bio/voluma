/**
 * Payloads of the events the agent model adds to the run log (`events.ts` wires them in;
 * the design is `event-log.md` of the agent-model work). Nothing writes or reads most of them
 * yet: they are in the log's vocabulary first so every deployed parser accepts them before any
 * writer exists. The API writes `tocheck.resolved`, `approval.given`, `approval.declined` and
 * `view.saved`; the runner writes the rest.
 */
import { z } from "zod";
import { userIdSchema } from "./auth";
import { segmentSchema } from "./ids";
import { linkRoleSchema, outputEntrySchema, viewSchema } from "./output-catalog";
import { relativePathSchema, sha256Schema } from "./r2";
import { focusSchema } from "./review";

const nonEmpty = z.string().min(1);

/**
 * An output as other outputs and events name it: its catalog id, or `<worker>/<id>` for one a
 * worker reported that the catalog does not declare (so two workers' local masks never become
 * versions of one output).
 */
export const outputRefSchema = z
  .string()
  .regex(/^[^/]+(\/[^/]+)?$/)
  .refine((s) => s.split("/").every((p) => segmentSchema.safeParse(p).success), {
    message: "must be an output id, or <worker>/<id>",
  });

/** Versions count from 1 per output. */
export const versionSchema = z.int().positive();

/** What `madeFrom` holds: the exact version of an output that this one used, and how. */
export const madeFromSchema = z.object({
  id: outputRefSchema,
  version: versionSchema,
  role: linkRoleSchema,
});

/** A To check item a person must judge; on an output version, `tocheck.resolved` names it by position. */
export const toCheckItemSchema = z.object({ title: nonEmpty, focus: focusSchema.optional() });

/**
 * The run's final outputs changed. The first one, from the runner at the run's start, sets the
 * list from the workflow's catalog and the researcher's selection; main's later ones come from
 * `change_outputs`. `add` carries whole entries, so the fold needs no workflow files. `sections`
 * replaces the grouping; `expect` appends lines to an output's own.
 */
export const outputsChangedSchema = z
  .object({
    by: z.enum(["runner", "main"]),
    reason: nonEmpty,
    add: z.array(outputEntrySchema).optional(),
    drop: z.array(segmentSchema).optional(),
    missing: z.array(z.object({ id: segmentSchema, reason: nonEmpty })).optional(),
    sections: z
      .array(z.object({ title: nonEmpty, outputs: z.array(segmentSchema).min(1) }))
      .optional(),
    expect: z.array(z.object({ id: segmentSchema, lines: z.array(nonEmpty).min(1) })).optional(),
  })
  .refine((p) => Object.keys(p).some((k) => k !== "by" && k !== "reason"), {
    message: "a change changes something",
  });

export type OutputsChange = z.infer<typeof outputsChangedSchema>;

/**
 * A message between agents or to the researcher. `from` and `to` are `main`, a worker's name or
 * `researcher`. `show` points the researcher at an output, optionally in a view.
 */
export const agentMessageSchema = z.object({
  from: nonEmpty,
  to: nonEmpty,
  text: nonEmpty,
  show: z
    .object({
      output: outputRefSchema,
      version: versionSchema.optional(),
      view: viewSchema.optional(),
    })
    .optional(),
});

/** The researcher accepted or corrected one To check item. Written by the API. */
export const tocheckResolvedSchema = z.object({
  output: outputRefSchema,
  version: versionSchema,
  /** Index into that version's `toCheck`. */
  item: z.int().nonnegative(),
  by: userIdSchema,
  outcome: z.enum(["accepted", "corrected"]),
});

/** An agent's wrap-up starts (`thread.ended` with status `closed` follows). `threadId` is the agent closing. */
export const closeRequestedSchema = z.object({
  threadId: nonEmpty,
  by: z.enum(["self", "main", "ping"]),
});

/** The idle ping was recorded, before it is sent. */
export const pingSchema = z.object({ threadId: nonEmpty });

/** A gated tool call held for the researcher in review. `fileHashes` are taken when the request is made. */
export const approvalRequestedSchema = z.object({
  toolCallId: nonEmpty,
  tool: nonEmpty,
  args: z.unknown(),
  fileHashes: z.record(relativePathSchema, sha256Schema),
  summary: nonEmpty,
});

/** The researcher's answer to an `approval.requested`; written by the API. */
export const approvalAnsweredSchema = z.object({
  toolCallId: nonEmpty,
  text: z.string().optional(),
});

/** A command that outlived its foreground wait and now runs in the background. */
export const bashBackgroundedSchema = z.object({ bashId: nonEmpty, command: nonEmpty });

/**
 * A background command ended. `cutOff` is written by the next claim for one the last claim's
 * sandbox took down, which has no exit status.
 */
export const bashEndedSchema = z
  .object({
    bashId: nonEmpty,
    exit: z.int().optional(),
    output: z.string(),
    cutOff: z.literal(true).optional(),
  })
  .refine((p) => (p.exit === undefined) === (p.cutOff === true), {
    path: ["exit"],
    message: "a command has an exit status unless it was cut off",
  });

/** Code loaded a skill into an agent's context; recorded so a resume does not load it twice. */
export const skillLoadedSchema = z.object({ name: nonEmpty, cause: nonEmpty });

/** The researcher saved a view of an output; `view` is the `.view.json` format. Written by the API. */
export const viewSavedSchema = z.object({ output: outputRefSchema, view: viewSchema });
