/**
 * Payloads of the events the agent model adds to the run log (`events.ts` wires them in;
 * the design is `event-log.md` of the agent-model work). Nothing writes or reads most of them
 * yet: they are in the log's vocabulary first so every deployed parser accepts them before any
 * writer exists. The API writes `tocheck.resolved`, `approval.given`, `approval.declined` and
 * `view.saved`; the runner writes the rest. Who an event is about is its envelope's thread.
 *
 * Stored payloads never embed an authoring schema (`outputs.yaml`'s entries): a change to the
 * schema would then stop stored events parsing. Entries are kept loose here and checked strictly
 * by whoever writes them.
 */
import { z } from "zod";
import { userIdSchema } from "./auth";
import { linkRoleSchema, outputKindSchema, outputRefSchema, viewSchema } from "./output-catalog";
import { relativePathSchema, sha256Schema } from "./r2";
import { focusSchema } from "./review";

const nonEmpty = z.string().min(1);

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
 * `change_outputs`, and the stuck-run rule writes `missing`. `add` carries whole catalog entries
 * so the fold needs no workflow files; they are stored loose (`id`, `kind`, the rest passes
 * through) and checked against the catalog by the writer. `sections` replaces the grouping;
 * `expect` appends lines to an output's own.
 */
export const outputsChangedSchema = z
  .object({
    by: z.enum(["runner", "main", "rule"]),
    reason: nonEmpty,
    add: z.array(z.looseObject({ id: outputRefSchema, kind: outputKindSchema })).optional(),
    drop: z.array(outputRefSchema).optional(),
    missing: z.array(z.object({ id: outputRefSchema, reason: nonEmpty })).optional(),
    sections: z
      .array(z.object({ title: nonEmpty, outputs: z.array(outputRefSchema).min(1) }))
      .optional(),
    expect: z.array(z.object({ id: outputRefSchema, lines: z.array(nonEmpty).min(1) })).optional(),
  })
  .refine((p) => Object.keys(p).some((k) => k !== "by" && k !== "reason"), {
    message: "a change changes something",
  });

/** A file of a published version: `name` is relative to the version's folder (`path`). */
const versionFileSchema = z.object({ name: relativePathSchema, sha256: sha256Schema });

/**
 * One published version of an output; it is never changed. The thread that reported it is the
 * envelope's. `kind` and `base` are on every version because the fold has no catalog.
 */
export const outputPublishedSchema = z
  .object({
    outputId: outputRefSchema,
    version: versionSchema,
    /** The version's folder, relative to the run's prefix. */
    path: relativePathSchema,
    /** The first is the output's own file, the one out of date is judged by; the rest travel with it. A value has none. */
    files: z.array(versionFileSchema).min(1).optional(),
    /** A value's number; `unit` is UCUM. */
    value: z.object({ number: z.number(), unit: nonEmpty }).optional(),
    kind: outputKindSchema,
    /** An overlay's base. */
    base: outputRefSchema.optional(),
    madeFrom: z.array(madeFromSchema),
    /** Files that show why it is right, under the version's folder (`evidence/...`). */
    evidence: z.array(versionFileSchema).optional(),
    toCheck: z.array(toCheckItemSchema).optional(),
    /** No reference comparison yet. */
    provisional: z.boolean().optional(),
    /** Written by `keep_output`: an old version kept after a look, with the reason. */
    kept: z.object({ reason: nonEmpty }).optional(),
    /**
     * What the review's asset converter needs per kind, which the fold ignores. Today it reads,
     * from the task loop's `output` block: for an image, `dtype` and `unit` (a float32 `HU` scan
     * is loaded as int16); for a mask or labels map, the `gridId` it was made on; for a
     * surface, its `axis`; and the representation to convert as (`as`: `image`, `labels`,
     * `mask`, `surface`). The writer fills them from the catalog's `shape` and the file.
     */
    detail: z.looseObject({}).optional(),
  })
  .refine((p) => p.files !== undefined || p.value !== undefined, {
    message: "a version has files or a value",
  });

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

/**
 * The researcher accepts one To check item of an output version: `POST
 * /api/review/runs/:runId/tocheck/accept`, answered 200 `{}`. The API writes `tocheck.resolved
 * {outcome: accepted}` with the caller as `by`; accepting an item already resolved writes
 * nothing. 404: a run the caller can't read, or an output, version or item it does not have;
 * 403: an example run. Allowed while the run goes: an item is a person's call on a version that
 * never changes. A corrected item is the API's to write once corrections exist (phase 7).
 */
export const acceptToCheckRequestSchema = tocheckResolvedSchema.pick({
  output: true,
  version: true,
  item: true,
});
export type AcceptToCheckRequest = z.infer<typeof acceptToCheckRequestSchema>;
export const acceptToCheckResponseSchema = z.object({});

/** An agent's wrap-up starts (`thread.ended` with status `closed` follows). `threadId` is the agent closing. */
export const closeRequestedSchema = z.object({
  threadId: nonEmpty,
  by: z.enum(["self", "main", "ping"]),
});

/** The idle ping was recorded, before it is sent. */
export const pingSchema = z.object({ threadId: nonEmpty });

/** A gated tool call held for the researcher in review. `fileHashes` are taken when the request is made; their keys are relative to the run's prefix. */
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
 * sandbox took down; its `exit` is the one the sandbox gave (137), not a result.
 */
export const bashEndedSchema = z
  .object({
    bashId: nonEmpty,
    exit: z.int().optional(),
    output: z.string(),
    cutOff: z.literal(true).optional(),
  })
  .refine((p) => p.exit !== undefined || p.cutOff === true, {
    path: ["exit"],
    message: "a command has an exit status unless it was cut off",
  });

/** Code loaded a skill into an agent's context; recorded so a resume does not load it twice. */
export const skillLoadedSchema = z.object({ name: nonEmpty, cause: nonEmpty });

/** The researcher saved a view of an output; `view` is the `.view.json` format. Written by the API. */
export const viewSavedSchema = z.object({ output: outputRefSchema, view: viewSchema });

/**
 * The researcher saves a view of an output: `POST /api/review/runs/:runId/views`, answered 200
 * `{}`. The API writes `view.saved` as sent, by the caller. 404: a run the caller can't read, or an
 * output it doesn't have; 403: an example run. Allowed while the run goes. At most
 * `MAX_VIEW_BYTES` of JSON.
 */
export const saveViewRequestSchema = viewSavedSchema;
export type SaveViewRequest = z.infer<typeof saveViewRequestSchema>;
export const saveViewResponseSchema = z.object({});
export const MAX_VIEW_BYTES = 64 * 1024;
