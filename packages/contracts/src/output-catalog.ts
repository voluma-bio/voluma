/**
 * The outputs of a workflow in the agent model: what `workflows/<name>/outputs.yaml` declares.
 * Nothing here is about one domain: a workflow names its own things (bones, molecules) in the
 * file, not in this schema. This is an authoring schema: no stored payload embeds it
 * (`packages/contracts/.context/CONTEXT.md`).
 *
 * An output is one of five kinds. A `base` is what a scene is drawn on and fixes its coordinates;
 * an `overlay` is drawn on a base; a `value` is a number with a UCUM unit, always measured `on`
 * at least one overlay; a `file` is anything else, opened by its media type; a `collection` is a
 * list of records of unknown length whose members are typed by the other kinds. Links between
 * outputs have a role (`linkRoleSchema`): `on` and `context` of a value, `base` of an overlay,
 * `input` for what a step read (reported with a version, in `madeFrom`; not declared here).
 *
 * The file is strict and cross-checked: a dangling id, a link to the wrong kind or a cycle fails
 * with the path to it. `loadWorkflow` (`packages/workflow`) parses it for every run, and
 * `@voluma/workflow/bundled` parses it at build time for the web app. Write `"on":` quoted:
 * PyYAML reads a bare `on` key as `True`, and the loader refuses it.
 */
import { z } from "zod";
import { segmentSchema } from "./ids";

const nonEmpty = z.string().min(1);

/**
 * An output as other outputs and events name it: its catalog id, or `<worker>/<id>` for one a
 * worker reported that the catalog does not declare (so two workers' local masks never become
 * versions of one output). Every place a stored payload names an output takes this.
 */
export const outputRefSchema = z
  .string()
  .regex(/^[^/]+(\/[^/]+)?$/)
  .refine((s) => s.split("/").every((p) => segmentSchema.safeParse(p).success), {
    message: "must be an output id, or <worker>/<id>",
  });

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
export const viewSchema = z.looseObject({ shown: z.array(outputRefSchema).optional() });
export type View = z.infer<typeof viewSchema>;

/**
 * What an overlay is stored as: `labels` (an integer map, one value per structure), `mask`
 * (binary voxels), `surface` (a height map over an axis), `point` and `line` (annotations a
 * ruler or a landmark draws).
 */
export const overlayShapeSchema = z.enum(["labels", "mask", "surface", "point", "line"]);

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
  /**
   * The heading it is listed under where the outputs are grouped: the start screen's list and,
   * from the run's opening change, its final outputs. Sections follow catalog order.
   */
  section: nonEmpty.optional(),
  /** How it opens in review: its presets, the first the default. */
  views: z.array(viewSchema).min(1).optional(),
};

/** A member of a collection: typed like an output; a link names a sibling member first, then a catalog id. */
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

/** The anatomical plane a grid's plane lies in; review colours each plane by it (DESIGN.md). */
export const anatomySchema = z.enum(["axial", "coronal", "sagittal"]);
export type Anatomy = z.infer<typeof anatomySchema>;

export const outputEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...entryBase,
    kind: z.literal("base"),
    /** Another base this one is resampled from or registered to, so overlays on either draw in one scene. */
    from: segmentSchema.optional(),
    /**
     * Which anatomical plane each of the grid's planes is: XY holds z (the array's first axis)
     * constant, XZ holds y, YZ holds x. Absent: review shows the planes uncoloured.
     */
    planes: z.strictObject({ XY: anatomySchema, XZ: anatomySchema, YZ: anatomySchema }).optional(),
  }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("overlay"),
    /** The base it is drawn on. */
    base: segmentSchema,
    /**
     * How it is represented, for the viewer and the workflow's converter. Required, except on a
     * label overlay, which has the map's.
     */
    shape: overlayShapeSchema.optional(),
    /**
     * This overlay is one value of another overlay's label map: the map holds the voxels, this
     * names the part of it. It is reported with the map, never as a file of its own, so a link to
     * it (`on`, `context`, `madeFrom`) resolves to the map's version: fixing one label makes
     * everything linked to any label of that map out of date, and main keeps the rest in one
     * call. The map must be an overlay of shape `labels` that is itself no label.
     */
    label: z.strictObject({ of: segmentSchema, value: z.int().positive() }).optional(),
    /**
     * A surface review fits one plane through, with every other surface of the same `code`, so
     * the views can be aligned to it and a pane can show it ("GP", "growth plate").
     */
    fitsPlane: z
      .strictObject({ code: z.string().regex(/^[A-Z]{1,3}$/), name: nonEmpty })
      .optional(),
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

/** The ids in `selected` that are not a `selectable` output of `catalog` (a run can't select them). */
export const unselectable = (catalog: readonly OutputEntry[], selected: readonly string[]) => {
  const byId = new Map(catalog.map((e) => [e.id, e]));
  return selected.filter((id) => !byId.get(id)?.selectable);
};

/**
 * `entries` grouped by `section`, in the order each section first appears; the entries without
 * one come last, as one group with no title (the only group when no entry names a section).
 */
export function groupBySection<T extends { section?: string }>(
  entries: readonly T[],
): { title?: string; entries: T[] }[] {
  const titled = new Map<string, T[]>();
  const rest: T[] = [];
  for (const e of entries)
    if (e.section === undefined) rest.push(e);
    else titled.set(e.section, [...(titled.get(e.section) ?? []), e]);
  return [
    ...[...titled].map(([title, group]) => ({ title, entries: group })),
    ...(rest.length > 0 ? [{ entries: rest }] : []),
  ];
}

/** The map whose version holds `id`'s voxels when the catalog lists `id` as a label overlay, else `id`. */
export const labelMapOf = (catalog: readonly OutputEntry[], id: string): string => {
  const e = catalog.find((x) => x.id === id);
  return e?.kind === "overlay" && e.label ? e.label.of : id;
};

/** Each label overlay the catalog lists, to its map (`{overlayId: mapId}`): what the opening `outputs.changed` records as `labels`. */
export const labelMapsOf = (catalog: readonly OutputEntry[]): Record<string, string> =>
  Object.fromEntries(
    catalog.flatMap((e) => (e.kind === "overlay" && e.label ? [[e.id, e.label.of]] : [])),
  );

/** The shapes the review converter reads from a `.npy` (`detail.as`); a point or line has no array. */
const CONVERTED_SHAPES = new Set<string>(["labels", "mask", "surface"]);

/** How the review converter reads a listed output's file (`detail.as`), where the catalog fixes it. */
export const convertedAs = (entry: OutputEntry): string | undefined =>
  entry.kind === "base"
    ? "image"
    : entry.kind === "overlay" && entry.shape && CONVERTED_SHAPES.has(entry.shape)
      ? entry.shape
      : undefined;

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

type Path = (string | number)[];

/** Every problem in `entries`: ids, link kinds, label maps, views, collection members and cycles. */
function problemsOf(entries: OutputEntry[]): { path: Path; message: string }[] {
  const problems: { path: Path; message: string }[] = [];
  const issue = (path: Path, message: string) => {
    problems.push({ path, message });
  };
  const byId = new Map<string, { entry: OutputEntry; index: number }>();
  for (const [index, entry] of entries.entries()) {
    if (byId.has(entry.id)) issue([index, "id"], `duplicate id "${entry.id}"`);
    else byId.set(entry.id, { entry, index });
  }
  const kindOf = (id: string) => byId.get(id)?.entry.kind;
  /** Checks that `id` is a catalog output of `kind`; `at` names the field. */
  const expectKind = (at: Path, id: string, kind: OutputKind) => {
    const found = kindOf(id);
    if (!found) issue(at, `"${id}" is not an output of this file`);
    else if (found !== kind)
      issue(at, `"${id}" is a ${found}, not ${kind === "overlay" ? "an overlay" : `a ${kind}`}`);
  };

  const labelValues = new Map<string, Set<number>>();
  for (const [index, e] of entries.entries()) {
    const at = (...field: Path) => [index, ...field];
    if (e.kind === "base" && e.from) expectKind(at("from"), e.from, "base");
    if (e.kind === "overlay") {
      expectKind(at("base"), e.base, "base");
      if (!e.label && !e.shape) issue(at("shape"), "an overlay that is no label has a shape");
      if (e.label) {
        if (e.shape) issue(at("shape"), "a label overlay has the shape of its map");
        expectKind(at("label", "of"), e.label.of, "overlay");
        const map = byId.get(e.label.of)?.entry;
        if (map?.kind === "overlay") {
          if (map.label)
            issue(at("label", "of"), `"${map.id}" is itself a label of "${map.label.of}"`);
          else if (map.shape !== "labels")
            issue(at("label", "of"), `"${map.id}" is not a labels overlay`);
          if (map.base !== e.base)
            issue(at("label", "of"), `"${map.id}" is drawn on "${map.base}", not on "${e.base}"`);
        }
        const seen = labelValues.get(e.label.of) ?? new Set<number>();
        if (seen.has(e.label.value))
          issue(at("label", "value"), `label ${e.label.value} of "${e.label.of}" is taken`);
        seen.add(e.label.value);
        labelValues.set(e.label.of, seen);
      }
    }
    if (e.kind === "value") {
      for (const [i, id] of e.on.entries()) expectKind(at("on", i), id, "overlay");
      for (const [i, id] of (e.context ?? []).entries())
        expectKind(at("context", i), id, "overlay");
    }
    for (const [v, view] of (e.views ?? []).entries())
      view.shown?.forEach((id, i) => {
        const k = kindOf(id);
        const where = at("views", v, "shown", i);
        if (!k) issue(where, `"${id}" is not an output of this file`);
        else if (k !== "overlay" && k !== "base")
          issue(where, `"${id}" is a ${k}, which a view cannot draw`);
      });
    if (e.kind === "collection") {
      // A member's link names a sibling first, then a catalog output.
      const resolve = (id: string) => e.members[id]?.kind ?? kindOf(id);
      for (const [name, m] of Object.entries(e.members)) {
        const member = (...field: Path) => at("members", name, ...field);
        if (m.kind === "overlay" && resolve(m.base) !== "base")
          issue(member("base"), `"${m.base}" is not a base`);
        if (m.kind === "value")
          m.on.forEach((id, i) => {
            if (resolve(id) !== "overlay") issue(member("on", i), `"${id}" is not an overlay`);
          });
      }
    }
  }

  // Depth-first from each output along its links; a path that returns to itself is a cycle.
  const state = new Map<string, "open" | "done">();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      const found = byId.get(id);
      if (found)
        issue([found.index], `cycle: ${[...trail.slice(trail.indexOf(id)), id].join(" -> ")}`);
      return;
    }
    state.set(id, "open");
    const found = byId.get(id);
    if (found)
      for (const target of linksOf(found.entry))
        if (byId.has(target)) visit(target, [...trail, id]);
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
    for (const p of problemsOf(entries)) ctx.addIssue({ code: "custom", ...p });
  });
export type OutputCatalog = z.infer<typeof outputCatalogSchema>;

const SUPERSCRIPT: Record<string, string> = { "2": "²", "3": "³", "-1": "⁻¹", "-2": "⁻²" };

/**
 * A value's UCUM unit as people write it: `mm3` → `mm³`, `[hnsf'U]` → `HU`,
 * `um` → `µm`, `1/mm3` → `1/mm³`; annotations in braces drop out. A plain number (UCUM `1`)
 * has no unit: `""`.
 */
export const unitAsWritten = (ucum: string): string =>
  (ucum === "1" ? "" : ucum)
    .replaceAll("[hnsf'U]", "HU")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\bu(?=[mgLl])/g, "µ")
    .replace(
      /([A-Za-zµ])(-?\d)/g,
      (_, unit: string, power: string) => unit + (SUPERSCRIPT[power] ?? power),
    )
    .replaceAll(".", "·")
    .trim();
