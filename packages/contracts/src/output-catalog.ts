/**
 * The outputs of a workflow in the agent model: what `workflows/<name>/outputs.yaml` declares and
 * what `/run/final-outputs.yaml` lists for one run. Nothing here is about one domain: a workflow
 * names its own things (bones, molecules) in the files, not in this schema.
 *
 * An output is one of five kinds. A `base` is what a scene is drawn on and fixes its coordinates;
 * an `overlay` is drawn on a base; a `value` is a number with a UCUM unit, always measured `on`
 * at least one overlay; a `file` is anything else, opened by its media type; a `collection` is a
 * list of records of unknown length whose members are typed by the other kinds. Links between
 * outputs have a role (`linkRoleSchema`): `on` and `context` of a value, `base` of an overlay,
 * `input` for what a step read (reported with a version, in `madeFrom`; not declared here).
 *
 * Both files are strict and cross-checked: a dangling id, a link to the wrong kind or a cycle
 * fails with the path to it. `loadWorkflow` (`packages/workflow`) parses `outputs.yaml`;
 * `outputs.json`, which today's task loop reads, is `workflow-files.ts`.
 */
import { z } from "zod";
import { segmentSchema } from "./ids";

const nonEmpty = z.string().min(1);

export const outputKindSchema = z.enum(["base", "overlay", "value", "file", "collection"]);
export type OutputKind = z.infer<typeof outputKindSchema>;

/** How one output was used by another: see the header. */
export const linkRoleSchema = z.enum(["on", "context", "base", "input"]);
export type LinkRole = z.infer<typeof linkRoleSchema>;

/**
 * The ids of the outputs a view shows. The rest of a view is the viewer's own state and passes
 * through: `quad_view.py` writes the format today (`<out>.view.json`: crosshair, camera, planes,
 * zoom, the layers shown), so a view an agent looked at and one a researcher saves are the same
 * thing. A preset in `outputs.yaml` holds the part that is not specific to one scan.
 */
export const viewSchema = z.looseObject({ shown: z.array(segmentSchema).optional() });
export type View = z.infer<typeof viewSchema>;

const entryBase = {
  id: segmentSchema,
  /** The label people see. */
  name: nonEmpty,
  /** Plain-text definition of what it is and where, for agents and the review screen. */
  description: nonEmpty.optional(),
  /** Where the expected value or definition comes from, e.g. the lab deck's number. */
  source: nonEmpty.optional(),
  /** What a correct one looks like, one check per line. Main may add lines for one scan (`outputs.changed`). */
  expect: z.array(nonEmpty).optional(),
  /** The researcher can pick it at the start of a run. */
  selectable: z.boolean().optional(),
  /** How it opens in review: its one preset. */
  view: viewSchema.optional(),
};

/** A member of a collection: typed like an output, linked to its siblings by member name. */
const memberSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("base") }),
  z.strictObject({ kind: z.literal("overlay"), base: segmentSchema }),
  z.strictObject({
    kind: z.literal("value"),
    unit: nonEmpty,
    on: z.array(segmentSchema).min(1),
  }),
  z.strictObject({ kind: z.literal("file"), mediaType: nonEmpty }),
]);

export const outputEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...entryBase,
    kind: z.literal("base"),
    /** Another base this one is resampled from or registered to, so overlays on either draw in one scene. */
    from: segmentSchema.optional(),
  }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("overlay"),
    /** The base it is drawn on. */
    base: segmentSchema,
    /** A hint to the viewer for how it is drawn (a surface, a line); the workflow's converter reads it. */
    shape: nonEmpty.optional(),
    /**
     * This overlay is one value of another overlay's label map: the map holds the voxels, this
     * names the part of it. It is reported with the map, never as a file of its own.
     */
    label: z.strictObject({ of: segmentSchema, value: z.int().positive() }).optional(),
  }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("value"),
    /** UCUM (`mm`, `mm3`, `%`, `1/mm`). */
    unit: nonEmpty,
    /** The overlays it is measured on; shown with it. A number always has something to look at. */
    on: z.array(segmentSchema).min(1),
    /** Overlays drawn beside it to judge it. */
    context: z.array(segmentSchema).optional(),
    /** Acceptance range `[min, max]` in `unit`; advice for the review screen. */
    range: z
      .tuple([z.number(), z.number()])
      .refine(([min, max]) => min <= max, "range must be [min, max] with min <= max")
      .optional(),
    /** The study page plots this value for every scan. */
    headline: z.boolean().optional(),
    /** No reference comparison yet: review labels it instead of hiding it. */
    provisional: z.boolean().optional(),
  }),
  z.strictObject({ ...entryBase, kind: z.literal("file"), mediaType: nonEmpty }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("collection"),
    members: z.record(segmentSchema, memberSchema).refine((m) => Object.keys(m).length > 0, {
      message: "a collection has at least one member",
    }),
  }),
]);
export type OutputEntry = z.infer<typeof outputEntrySchema>;

/** Where an entry sits in the file being checked, so a problem reports its path. */
interface Located {
  entry: OutputEntry;
  path: (string | number)[];
}

/** The ids `entry` links to, for the cycle check. */
function linksOf(entry: OutputEntry): string[] {
  switch (entry.kind) {
    case "base":
      return entry.from ? [entry.from] : [];
    case "overlay":
      return entry.label ? [entry.base, entry.label.of] : [entry.base];
    case "value":
      return [...entry.on, ...(entry.context ?? [])];
    default:
      return [];
  }
}

/** Every problem across `located`: ids, link kinds, label maps, views, collection members and cycles. */
function problemsOf(located: Located[]): { path: (string | number)[]; message: string }[] {
  const problems: { path: (string | number)[]; message: string }[] = [];
  const issue = (path: (string | number)[], message: string) => {
    problems.push({ path, message });
  };
  const byId = new Map<string, Located>();
  for (const l of located) {
    if (byId.has(l.entry.id)) issue([...l.path, "id"], `duplicate id "${l.entry.id}"`);
    else byId.set(l.entry.id, l);
  }
  const kindOf = (id: string) => byId.get(id)?.entry.kind;
  /** Checks that `id` exists and has `kind`; the message names the field. */
  const expectKind = (l: Located, field: (string | number)[], id: string, kind: OutputKind) => {
    const found = kindOf(id);
    if (!found) issue([...l.path, ...field], `"${id}" is not an output of this file`);
    else if (found !== kind)
      issue(
        [...l.path, ...field],
        `"${id}" is a ${found}, not ${kind === "overlay" ? "an overlay" : `a ${kind}`}`,
      );
  };

  const labelValues = new Map<string, Set<number>>();
  for (const l of located) {
    const e = l.entry;
    if (e.kind === "base" && e.from) expectKind(l, ["from"], e.from, "base");
    if (e.kind === "overlay") {
      expectKind(l, ["base"], e.base, "base");
      if (e.label) {
        expectKind(l, ["label", "of"], e.label.of, "overlay");
        const map = byId.get(e.label.of)?.entry;
        if (map?.kind === "overlay" && map.base !== e.base)
          issue(
            [...l.path, "label", "of"],
            `"${map.id}" is drawn on "${map.base}", not on "${e.base}"`,
          );
        const seen = labelValues.get(e.label.of) ?? new Set<number>();
        if (seen.has(e.label.value))
          issue(
            [...l.path, "label", "value"],
            `label ${e.label.value} of "${e.label.of}" is taken`,
          );
        seen.add(e.label.value);
        labelValues.set(e.label.of, seen);
      }
    }
    if (e.kind === "value") {
      for (const [i, id] of e.on.entries()) expectKind(l, ["on", i], id, "overlay");
      for (const [i, id] of (e.context ?? []).entries())
        expectKind(l, ["context", i], id, "overlay");
    }
    e.view?.shown?.forEach((id, i) => {
      const k = kindOf(id);
      if (!k) issue([...l.path, "view", "shown", i], `"${id}" is not an output of this file`);
      else if (k !== "overlay" && k !== "base")
        issue([...l.path, "view", "shown", i], `"${id}" is a ${k}, which a view cannot draw`);
    });
    if (e.kind === "collection") {
      for (const [name, m] of Object.entries(e.members)) {
        const at = [...l.path, "members", name];
        if (m.kind === "overlay" && e.members[m.base]?.kind !== "base")
          issue([...at, "base"], `"${m.base}" is not a base member`);
        if (m.kind === "value")
          m.on.forEach((id, i) => {
            if (e.members[id]?.kind !== "overlay")
              issue([...at, "on", i], `"${id}" is not an overlay member`);
          });
      }
    }
  }

  // Depth-first from each output along its links; a path that returns to itself is a cycle.
  const state = new Map<string, "open" | "done">();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      const at = byId.get(id);
      if (at) issue(at.path, `cycle: ${[...trail.slice(trail.indexOf(id)), id].join(" -> ")}`);
      return;
    }
    state.set(id, "open");
    const l = byId.get(id);
    if (l)
      for (const target of linksOf(l.entry)) if (byId.has(target)) visit(target, [...trail, id]);
    state.set(id, "done");
  };
  for (const id of byId.keys()) visit(id, []);
  return problems;
}

/** `outputs.yaml`: every output a run of the workflow can produce. */
export const outputCatalogSchema = z
  .array(outputEntrySchema)
  .min(1)
  .superRefine((entries, ctx) => {
    for (const p of problemsOf(entries.map((entry, i) => ({ entry, path: [i] }))))
      ctx.addIssue({ code: "custom", ...p });
  });
export type OutputCatalog = z.infer<typeof outputCatalogSchema>;

/** The ids of `catalog` a researcher can pick when starting a run. */
export const selectableIds = (catalog: OutputCatalog) =>
  catalog.filter((o) => o.selectable).map((o) => o.id);

/** One edit to a run's final outputs, in the order made. Mirrors `outputs.changed` (`agent-events.ts`). */
const changeSchema = z.strictObject({
  at: z.iso.datetime(),
  by: z.enum(["runner", "main"]),
  reason: nonEmpty,
  add: z.array(segmentSchema).optional(),
  drop: z.array(segmentSchema).optional(),
  missing: z.array(segmentSchema).optional(),
});

/**
 * `/run/final-outputs.yaml`, written by code from the run's `outputs.changed` events for main and
 * the workers to read. The entries are the catalog's, copied in, so a reader needs no other file.
 * An entry's links name entries of this file, so a value's basis is listed with it.
 */
export const finalOutputsSchema = z
  .strictObject({
    sections: z
      .array(z.strictObject({ title: nonEmpty, outputs: z.array(outputEntrySchema).min(1) }))
      .min(1),
    /** Outputs of the sections that cannot be made on this scan, with why. Only main marks one. */
    missing: z.array(z.strictObject({ id: segmentSchema, reason: nonEmpty })).optional(),
    changes: z.array(changeSchema),
  })
  .superRefine((file, ctx) => {
    const located = file.sections.flatMap((s, i) =>
      s.outputs.map((entry, j) => ({ entry, path: ["sections", i, "outputs", j] })),
    );
    for (const p of problemsOf(located)) ctx.addIssue({ code: "custom", ...p });
    const listed = new Set(located.map((l) => l.entry.id));
    file.missing?.forEach((m, i) => {
      if (!listed.has(m.id))
        ctx.addIssue({
          code: "custom",
          path: ["missing", i, "id"],
          message: `"${m.id}" is not listed`,
        });
    });
  });
export type FinalOutputs = z.infer<typeof finalOutputsSchema>;
