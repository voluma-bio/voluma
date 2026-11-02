/**
 * The run's final outputs: the delivered ids, in sections, that `/run/final-outputs.yaml` shows
 * and `close` waits for. Built from the run's `outputs.changed` events (`output-fold.ts`).
 *
 * The stored events are loose (`agent-events.ts`), so the fold applies any change it reads
 * (`applyOutputsChange` never refuses) and the writer checks the change first
 * (`refuseOutputsChange`): the runner's opening change and `change_outputs` call it with the
 * run's catalog and refuse there. Links are checked against the catalog, not against this
 * file: a value's basis is shown with it (`on`, `context`) but is not final and never blocks
 * `close`.
 */
import { z } from "zod";
import type { outputsChangedSchema } from "./agent-events";
import { type OutputCatalog, outputKindSchema, outputRefSchema } from "./output-catalog";

const nonEmpty = z.string().min(1);

type OutputsChange = z.infer<typeof outputsChangedSchema>;

/** A delivered output: its catalog entry (or the worker's own description of it), passed through. */
const finalEntrySchema = z.looseObject({ id: outputRefSchema, kind: outputKindSchema });
export type FinalEntry = z.infer<typeof finalEntrySchema>;

/** One edit to the final outputs, in the order made. */
const changeLogSchema = z.strictObject({
  at: z.iso.datetime(),
  by: z.enum(["runner", "main", "rule"]),
  reason: nonEmpty,
  add: z.array(outputRefSchema).optional(),
  drop: z.array(outputRefSchema).optional(),
  missing: z.array(outputRefSchema).optional(),
});

/** `/run/final-outputs.yaml`. */
export const finalOutputsSchema = z
  .strictObject({
    sections: z.array(
      z.strictObject({ title: nonEmpty, outputs: z.array(finalEntrySchema).min(1) }),
    ),
    /** Outputs of the sections that cannot be made on this scan, with why. Only main marks one. */
    missing: z.array(z.strictObject({ id: outputRefSchema, reason: nonEmpty })).optional(),
    changes: z.array(changeLogSchema),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.sections.forEach((s, i) => {
      s.outputs.forEach((entry, j) => {
        if (seen.has(entry.id))
          ctx.addIssue({
            code: "custom",
            path: ["sections", i, "outputs", j, "id"],
            message: `"${entry.id}" is listed twice`,
          });
        seen.add(entry.id);
      });
    });
    file.missing?.forEach((m, i) => {
      if (!seen.has(m.id))
        ctx.addIssue({
          code: "custom",
          path: ["missing", i, "id"],
          message: `"${m.id}" is not listed`,
        });
    });
  });
export type FinalOutputs = z.infer<typeof finalOutputsSchema>;

const OTHER = "Other";

export const sectionsOf = (list: FinalOutputs | undefined) => list?.sections ?? [];

/** Every entry of the list, in section order. */
export const entriesOf = (list: FinalOutputs | undefined): FinalEntry[] =>
  sectionsOf(list).flatMap((s) => s.outputs);

/**
 * The list after `change`; `list` is undefined before the first change. Total: what the writer
 * should have refused (`refuseOutputsChange`) is left out rather than throwing, so a stored event
 * never changes how the rest of the log folds. Order: `drop`, `add`, `missing`, `expect`, then
 * `sections`. Entries left out of `sections` (new ones, when it is absent) go in "Other".
 */
export function applyOutputsChange(
  list: FinalOutputs | undefined,
  change: OutputsChange,
  at: string,
): FinalOutputs {
  const dropped = new Set(change.drop ?? []);
  const entries = new Map<string, FinalEntry>();
  for (const e of [...entriesOf(list), ...(change.add ?? [])])
    if (!dropped.has(e.id) && !entries.has(e.id)) entries.set(e.id, e);
  for (const x of change.expect ?? []) {
    const e = entries.get(x.id);
    if (e)
      entries.set(x.id, {
        ...e,
        expect: [...(Array.isArray(e.expect) ? (e.expect as string[]) : []), ...x.lines],
      });
  }

  const seen = new Set<string>();
  const place = (ids: string[]) =>
    ids.filter((id) => entries.has(id) && !seen.has(id) && seen.add(id));
  const grouped = change.sections
    ? change.sections.map((s) => ({ title: s.title, ids: place(s.outputs) }))
    : sectionsOf(list).map((s) => ({ title: s.title, ids: place(s.outputs.map((o) => o.id)) }));
  const rest = place([...entries.keys()]);
  if (rest.length > 0) {
    const other = grouped.find((s) => s.title === OTHER);
    if (other) other.ids.push(...rest);
    else grouped.push({ title: OTHER, ids: rest });
  }

  const marked = new Map<string, { id: string; reason: string }>();
  for (const m of [...(list?.missing ?? []), ...(change.missing ?? [])])
    if (entries.has(m.id)) marked.set(m.id, m);
  const missing = [...marked.values()];
  return {
    sections: grouped
      .filter((s) => s.ids.length > 0)
      .flatMap((s) => ({
        title: s.title,
        outputs: s.ids.flatMap((id) => entries.get(id) ?? []),
      })),
    ...(missing.length > 0 && { missing }),
    changes: [
      ...(list?.changes ?? []),
      {
        at,
        by: change.by,
        reason: change.reason,
        ...(change.add && { add: change.add.map((e) => e.id) }),
        ...(change.drop && { drop: change.drop }),
        ...(change.missing && { missing: change.missing.map((m) => m.id) }),
      },
    ],
  };
}

/**
 * Why `change` must not be written, or undefined. For the writer (the runner's opening change,
 * `change_outputs`), which has the run's catalog: an id the catalog declares keeps its kind, one
 * it does not is a worker's own (`<worker>/<id>`), and the links of an added entry (`base`, `on`,
 * `context`) name catalog outputs, a worker's own, or something listed.
 */
export function refuseOutputsChange(
  list: FinalOutputs | undefined,
  change: OutputsChange,
  catalog: OutputCatalog,
): string | undefined {
  const declared = new Map(catalog.map((e) => [e.id, e]));
  const listed = new Set(entriesOf(list).map((e) => e.id));
  for (const id of change.drop ?? [])
    if (!listed.has(id)) return `${id} is not a final output, so it cannot be dropped`;
  for (const id of change.drop ?? []) listed.delete(id);

  const added = new Set<string>();
  for (const entry of change.add ?? []) {
    if (listed.has(entry.id) || added.has(entry.id)) return `${entry.id} is already a final output`;
    added.add(entry.id);
    const own = declared.get(entry.id);
    if (own && own.kind !== entry.kind)
      return `${entry.id} is ${own.kind} in the catalog, not ${entry.kind}`;
    if (!own && !entry.id.includes("/"))
      return `${entry.id} is not in the catalog; a worker's own output is <worker>/<id>`;
  }
  for (const id of added) listed.add(id);
  for (const entry of change.add ?? []) {
    const links = [entry.base, ...asList(entry.on), ...asList(entry.context)].filter(
      (l): l is string => typeof l === "string",
    );
    for (const link of links)
      if (!declared.has(link) && !link.includes("/") && !listed.has(link))
        return `${entry.id} links ${link}, which is not in the catalog`;
  }
  for (const m of change.missing ?? [])
    if (!listed.has(m.id)) return `${m.id} is not a final output, so it cannot be missing`;
  for (const x of change.expect ?? [])
    if (!listed.has(x.id)) return `${x.id} is not a final output, so it takes no expect lines`;
  const placed = new Set<string>();
  for (const s of change.sections ?? [])
    for (const id of s.outputs) {
      if (!listed.has(id)) return `${id} is not a final output, so it has no section`;
      if (placed.has(id)) return `${id} is in two sections`;
      placed.add(id);
    }
  return undefined;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
