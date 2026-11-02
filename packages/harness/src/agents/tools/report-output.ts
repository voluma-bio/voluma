/**
 * `report_output` of the agent loop: publishes one version of an output. The named files are
 * copied from the agent's `/work/<name>/` to the version's folder, `outputs/<id>/<toolCallId>/`
 * (read-only to agents), and hashed on the way; then the `output.published` event records the version,
 * its folder, files, `madeFrom`, evidence and To check items (`output.published`); then each
 * source is deleted and a `<file>.removed.txt` pointer to the published copy is left beside it,
 * so a published file is stored once.
 *
 * Checked against the catalog before anything is copied: the kind, a value's unit, the links
 * (each names a published version; a value is `on` the overlays the catalog lists, an overlay has
 * its base) and, for an id the catalog does not declare, that it is `<you>/<id>` with its `kind`.
 *
 * Version numbers: assigned inside the run's section, as the next after the output's latest
 * version, in the same step that appends the event. One runner holds a run's lease and a lease
 * lost stops the recorder, so no second writer exists to race for a number; the fold keeps the
 * first of two events that claim one anyway. The design's database constraint would need a
 * migration of the API's events table for a rule this section already keeps.
 *
 * A repeated or interrupted call (same tool call id): the event id is derived from the call, so
 * a call whose event is stored answers from it and copies nothing (it only finishes the move,
 * from the names in the event, so the source need not exist any more); one cut off during the
 * copy still finds its sources, copies to the same keys again and writes the event. The sources
 * go only after the event. Files copied by a call that never reached its event stay in the
 * bucket, and no event names them.
 */

import { madeFromSchema, toCheckItemSchema } from "@voluma/contracts/agent-events";
import {
  type OutputEntry,
  type OutputKind,
  outputKindSchema,
  outputRefSchema,
} from "@voluma/contracts/output-catalog";
import { OUTPUTS_MOUNT } from "@voluma/contracts/output-fold";
import {
  outputsPrefix,
  relativePathSchema,
  versionPath,
  versionPrefix,
} from "@voluma/contracts/r2";
import { z } from "zod";
import { EvidenceNotFound, EvidenceRefused } from "../../ports/evidence";
import type { Tool } from "../../tools/tool";
import { reportOutputId } from "../effects";
import {
  answerOf,
  type Caller,
  callerOf,
  eventById,
  foldOf,
  nextVersion,
  type OutputEvent,
  type OutputToolDeps,
  resolvedId,
} from "./output-shared";
import { Refusal, result } from "./refusal";

const inputSchema = z.object({
  id: outputRefSchema.describe(
    "The output's id from /run/final-outputs.yaml or /run/outputs.yaml. The ids of the workflow's outputs.yaml (under /workflow) are used as they are, listed in the final outputs or not. One it does not list is <your name>/<id>, and then kind (and base for an overlay, unit for a value) is required.",
  ),
  value: z.number().finite().optional().describe("The number, for an output of kind value."),
  unit: z
    .string()
    .min(1)
    .optional()
    .describe("UCUM unit; only for a value the workflow does not list (a listed one has its own)."),
  files: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      "Files in your /work folder, for every kind but value. The first is the output's own file, the one out of date is judged by; the rest (a sidecar) travel with it. Name files, not folders.",
    ),
  madeFrom: z
    .array(madeFromSchema)
    .describe(
      "The exact versions you used: {id, version, role}. role: on (a value measured on this overlay), context (drawn beside it), base (an overlay drawn on this base), input (anything else you read). A value needs an on link, an overlay its base link.",
    ),
  evidence: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Files in your /work folder that show why it is right (views, logs); published with the version.",
    ),
  toCheck: z
    .array(toCheckItemSchema)
    .optional()
    .describe("What a person must judge, in plain words about the scan: {title, focus?}."),
  provisional: z.boolean().optional().describe("No reference comparison yet."),
  kind: outputKindSchema.optional().describe("Only for an output the workflow does not list."),
  base: outputRefSchema
    .optional()
    .describe("An overlay's base; only for an output the workflow does not list."),
});
export type ReportOutputInput = z.infer<typeof inputSchema>;

/** What the call is, once the rules accept it. */
interface Plan {
  kind: OutputKind;
  base?: string;
  unit?: string;
  provisional?: true;
  /** How the review converter reads the file (`detail.as`), when the catalog says. */
  detail?: Record<string, unknown>;
  /** The listed overlay's shape, when the catalog fixes it. */
  shape?: string;
}

const SHAPE_AS = { labels: "labels", mask: "mask", surface: "surface" } as const;

/** The converter's representation of a listed output, where the catalog fixes it. */
function detailOf(entry: OutputEntry): Pick<Plan, "detail" | "shape"> {
  if (entry.kind === "base") return { detail: { as: "image" } };
  const as =
    entry.kind === "overlay" && entry.shape
      ? SHAPE_AS[entry.shape as keyof typeof SHAPE_AS]
      : undefined;
  return as ? { detail: { as }, shape: as } : {};
}

/**
 * What the review converter reads of a `.npy` that the sidecar beside it (`<name>.json`,
 * `workflows/core/skills/*\/resources/sidecar.py`) states: `dtype`; `gridId` of the grid it lives
 * on; `affine` (voxel (x, y, z) to mm, diagonal from `spacing_zyx_mm`: the sidecar knows no
 * rotation), read from the caller's latest published copy when an earlier report moved it away; a cropped array's `offsetZyx`; a surface's `axis`; a base's `unit`. Nothing is
 * refused for a missing sidecar.
 */
async function detailFromSidecar(
  deps: OutputToolDeps,
  kind: OutputKind,
  shape: string | undefined,
  key: string,
  publishedKey: string | undefined,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const text =
    (await deps.publish.read(key, { signal })) ??
    (publishedKey ? await deps.publish.read(publishedKey, { signal }) : undefined);
  let side: Record<string, unknown> = {};
  try {
    const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
    if (parsed && typeof parsed === "object") side = parsed as Record<string, unknown>;
  } catch {}
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const unit = str(side.units) ?? str(side.unit);
  const dtype = str(side.dtype);
  const gridId = str(side.grid_id);
  const triple = (v: unknown) =>
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
      ? (v as number[])
      : undefined;
  const spacing = triple(side.spacing_zyx_mm);
  const offset = triple(side.offset_zyx);
  return {
    ...(spacing && {
      affine: [
        [spacing[2], 0, 0, 0],
        [0, spacing[1], 0, 0],
        [0, 0, spacing[0], 0],
        [0, 0, 0, 1],
      ],
    }),
    ...(offset && { offsetZyx: offset }),
    ...(dtype && { dtype }),
    ...(gridId && { gridId }),
    ...(shape === "surface" &&
      typeof side.surface_axis === "number" && { axis: side.surface_axis }),
    ...(kind === "base" && unit && { unit }),
  };
}

/**
 * Where the caller's latest published copy of `rel` is, for a sidecar already moved out of the
 * folder: a file reported on its own (the scan's `hu.json`) is gone before the array it describes
 * is reported.
 */
function publishedCopy(deps: OutputToolDeps, caller: Caller, rel: string): string | undefined {
  const latest = [...foldOf(deps).byId.values()]
    .flatMap((o) => o.versions)
    .filter((v) => v.by === caller.name && v.files.some((f) => f.name === rel))
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  return latest && `${outputsPrefix(deps.runId)}${latest.path}/${rel}`;
}

const KEYS: Record<OutputKind, string> = {
  base: "a base",
  overlay: "an overlay",
  value: "a value",
  file: "a file",
  collection: "a collection",
};

function planOf(deps: OutputToolDeps, caller: Caller, input: ReportOutputInput): Plan {
  const { id } = input;
  const entry: OutputEntry | undefined = deps.catalog.find((e) => e.id === id);
  let plan: Plan;
  if (entry) {
    if (input.kind && input.kind !== entry.kind)
      throw new Refusal(`${id} is ${KEYS[entry.kind]} in this workflow, not ${KEYS[input.kind]}.`);
    if (input.base && (entry.kind !== "overlay" || input.base !== entry.base))
      throw new Refusal(`${id} is listed by the workflow; do not give base.`);
    if (input.unit && (entry.kind !== "value" || input.unit !== entry.unit))
      throw new Refusal(`${id} is listed by the workflow; do not give unit.`);
    plan = {
      kind: entry.kind,
      ...(entry.kind === "overlay" && { base: entry.base }),
      ...(entry.kind === "value" && { unit: entry.unit }),
      ...(entry.kind === "value" && entry.provisional && { provisional: true as const }),
      ...detailOf(entry),
    };
  } else {
    const [owner, own, ...rest] = id.split("/");
    if (own && deps.catalog.some((e) => e.id === own))
      throw new Refusal(
        `${own} is an output of this workflow: report it as ${own}, not ${id}. The workflow's outputs.yaml (under /workflow) lists every id.`,
      );
    if (!own || rest.length > 0 || owner !== caller.folder)
      throw new Refusal(
        `${id} is not an output of this workflow. To report one it does not list, name it ${caller.folder}/<id> and give its kind (base too for an overlay, unit for a value).`,
      );
    if (!input.kind) throw new Refusal(`${id} is not listed by the workflow: give its kind.`);
    if (input.kind === "value" && !input.unit)
      throw new Refusal(`${id} is a value: give its unit.`);
    if (input.kind === "overlay" && !input.base)
      throw new Refusal(`${id} is an overlay: give the base it is drawn on.`);
    plan = {
      kind: input.kind,
      ...(input.base && { base: input.base }),
      ...(input.unit && { unit: input.unit }),
    };
  }

  if (plan.kind === "value") {
    if (input.value === undefined) throw new Refusal(`${id} is a value: give value.`);
    if (input.files)
      throw new Refusal(
        `${id} is a value, so it has no files; put the files that show it in evidence.`,
      );
  } else {
    if (!input.files)
      throw new Refusal(`${id} is ${KEYS[plan.kind]}: give files, the first being its own file.`);
    if (input.value !== undefined) throw new Refusal(`${id} is ${KEYS[plan.kind]}, not a value.`);
  }

  const fold = foldOf(deps);
  const kindOf = (other: string) =>
    deps.catalog.find((e) => e.id === other)?.kind ?? fold.byId.get(other)?.kind;
  for (const link of input.madeFrom) {
    // A label overlay has no version of its own: the version named is its map's.
    const target = fold.byId.get(resolvedId(deps, link.id));
    if (!target?.versions.some((v) => v.version === link.version))
      throw new Refusal(
        `madeFrom names ${link.id} version ${link.version}, which is not published. ${
          target
            ? `Its versions: ${target.versions.map((v) => v.version).join(", ")}.`
            : `Nothing of ${link.id} is published yet; see /run/outputs.yaml.`
        }`,
      );
  }
  const linked = (role: string) => input.madeFrom.filter((l) => l.role === role).map((l) => l.id);
  if (plan.kind === "value") {
    const on = linked("on");
    const listed = entry?.kind === "value" ? entry.on : [];
    const missing = listed.filter((o) => !on.includes(o));
    if (missing.length > 0)
      throw new Refusal(
        `${id} is measured on ${missing.join(", ")}: add {id, version, role: "on"} to madeFrom for each.`,
      );
    if (on.length === 0)
      throw new Refusal(
        `${id} is a value, so madeFrom needs an "on" link to the overlay it is measured on.`,
      );
    for (const o of on)
      if (kindOf(o) !== "overlay")
        throw new Refusal(`${id} is "on" ${o}, which is not an overlay.`);
  }
  if (plan.kind === "overlay" && plan.base) {
    if (!linked("base").includes(plan.base))
      throw new Refusal(
        `${id} is drawn on ${plan.base}: add its version to madeFrom with role "base".`,
      );
    if (kindOf(plan.base) !== "base")
      throw new Refusal(`${plan.base} is not a base, so ${id} cannot be drawn on it.`);
  }
  return plan;
}

/** A path the agent named, as a path inside its own folder. */
function inOwnFolder(dir: string, resolved: string, what: string): string {
  const rel = resolved.startsWith(`${dir}/`) ? resolved.slice(dir.length + 1) : "";
  if (!relativePathSchema.safeParse(rel).success)
    throw new Refusal(
      `${what} ${resolved} is not a file in your folder ${dir}/. Copy it there first.`,
    );
  return rel;
}

export function reportOutput(deps: OutputToolDeps): Tool<typeof inputSchema> {
  const { recorder, publish, runId, section } = deps;
  return {
    name: "report_output",
    description:
      "Publish one version of an output: a value, or the files that make it. The files are moved out of your /work folder into /outputs/<id>/<toolCallId>/, which nobody can change, and recorded with what you made it from. Reporting an id again publishes a new version; the old one stays. Everything you cite in madeFrom must already be published.",
    input: inputSchema,
    execute: (input, ctx) =>
      result(async () => {
        const id = reportOutputId(ctx.threadId, ctx.toolCallId);
        const stored = (): OutputEvent | undefined => {
          const e = eventById(deps, id);
          return e?.type === "output.published" ? e.payload : undefined;
        };
        const layout = deps.layoutOf(ctx.threadId);
        // The move's second half. The source is gone once the event is stored, so a repeat works
        // from the event's names alone; the pointer goes first, so a source is never without one.
        const finishMove = async (p: OutputEvent) => {
          const moved = [
            ...(p.files ?? []).map((f) => f.name),
            ...(p.evidence ?? []).map((e) => e.name),
          ];
          for (const name of moved) {
            const key = layout.keyOf(`${layout.dir}/${name.replace(/^evidence\//, "")}`, "write");
            await deps.publish.write(
              `${key}.removed.txt`,
              `${name.split("/").pop()} was removed from this folder to save storage.\n` +
                `Its published copy is ${OUTPUTS_MOUNT}/${p.path}/${name} (output ${p.outputId}, version ${p.version}).\n`,
            );
            await deps.publish.remove(key);
          }
        };
        const done = stored();
        if (done) {
          await finishMove(done);
          return answerOf(done);
        }

        const caller = callerOf(deps, ctx.threadId);
        const plan = planOf(deps, caller, input);
        const publishFile = async (named: string, folder: "" | "evidence/") => {
          const path = layout.resolve(named);
          const rel = inOwnFolder(layout.dir, path, "The file");
          const sha256 = await publish
            .copy(
              layout.keyOf(path, "read"),
              `${versionPrefix(runId, input.id, ctx.toolCallId)}${folder}${rel}`,
              {
                hash: () => deps.hashIn(ctx.threadId, path, ctx.signal),
                signal: ctx.signal,
              },
            )
            .catch((error) => {
              if (error instanceof EvidenceNotFound)
                throw new Refusal(`No file at ${path}. Name files in your folder, not folders.`);
              if (error instanceof EvidenceRefused) throw new Refusal(error.message);
              throw error;
            });
          return { name: `${folder}${rel}`, sha256 };
        };
        const names = [...(input.files ?? []), ...input.evidence].map((n) => layout.resolve(n));
        if (new Set(names).size !== names.length) throw new Refusal("A file is named twice.");
        for (const n of input.files ?? [])
          if (inOwnFolder(layout.dir, layout.resolve(n), "The file").startsWith("evidence/"))
            throw new Refusal(
              "evidence/ is where the evidence of a version goes; give the file another path.",
            );

        const first = layout.resolve(input.files?.[0] ?? "");
        const sidecarPath = `${first.slice(0, -4)}.json`;
        const sidecar = first.endsWith(".npy")
          ? await detailFromSidecar(
              deps,
              plan.kind,
              plan.shape,
              layout.keyOf(sidecarPath, "read"),
              publishedCopy(deps, caller, inOwnFolder(layout.dir, sidecarPath, "The sidecar")),
              ctx.signal,
            )
          : {};
        const [files, evidence] = await Promise.all([
          Promise.all((input.files ?? []).map((f) => publishFile(f, ""))),
          Promise.all(input.evidence.map((f) => publishFile(f, "evidence/"))),
        ]);

        return section(async () => {
          const again = stored();
          if (again) {
            await finishMove(again);
            return answerOf(again);
          }
          const version = nextVersion(deps, input.id);
          const path = versionPath(input.id, ctx.toolCallId);
          const value = input.value;
          const payload: OutputEvent = {
            outputId: input.id,
            version,
            path,
            ...(files.length > 0 && { files }),
            ...(value !== undefined && plan.unit && { value: { number: value, unit: plan.unit } }),
            kind: plan.kind,
            ...(plan.base && { base: plan.base }),
            madeFrom: input.madeFrom,
            ...(evidence.length > 0 && { evidence }),
            ...(input.toCheck && { toCheck: input.toCheck }),
            ...((input.provisional || plan.provisional) && { provisional: true }),
            ...((plan.detail || Object.keys(sidecar).length > 0) && {
              detail: { ...sidecar, ...plan.detail },
            }),
          };
          await recorder.append(ctx.threadId, "output.published", payload, id);
          deps.changed();
          await deps.refreshRunFiles();
          await finishMove(payload);
          return answerOf(payload);
        });
      }),
  };
}
