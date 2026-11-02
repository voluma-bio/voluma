/**
 * What a final value is computed on, before and after anything is published: its "rests on"
 * chain, nearest first ("Patella ‹ Bone labels ‹ Scan"). A value rests on the overlays it is
 * measured `on`; a label overlay on its map; an overlay on its base; a base on the base it is
 * resampled `from`. Each step follows the published version where there is one (its `on` and
 * `base` links, or a base's link to another base), so the chain can't disagree with what was
 * published, and the workflow's catalog where the version names none. A link is in once a version of it is
 * published; a label overlay has no version of its own, so it is in once its map is.
 *
 * The whole trail behind a published version (every `madeFrom`, recursively) is `trailOf`
 * (`outputs-trail.ts`); this is only the spine of it the value is computed on.
 */
import type { OutputCatalog } from "@voluma/contracts/output-catalog";
import type { OutputStatus, OutputsFold } from "@voluma/contracts/output-fold";

export type ChainLink = {
  id: string;
  /** The status of what holds its voxels (a label's map); absent while nothing of it is published. */
  status?: OutputStatus;
};

/** The outputs `id` is computed on, one step back: published links first, else the catalog's. */
function stepBack(catalog: OutputCatalog, fold: OutputsFold, id: string): string[] {
  const entry = catalog.find((e) => e.id === id);
  const state = fold.byId.get(id);
  const kind = entry?.kind ?? state?.kind;
  const latest = state?.latest;
  // The published version's links of that kind; none named: the catalog's.
  const linked = (keep: (link: { id: string; role: string }) => boolean) => {
    const ids = latest?.madeFrom.filter((l) => l.id !== id && keep(l)).map((l) => l.id);
    return ids?.length ? ids : undefined;
  };
  if (kind === "value") {
    const loose = state?.entry?.on;
    const listed =
      entry?.kind === "value"
        ? entry.on
        : Array.isArray(loose)
          ? loose.filter((s): s is string => typeof s === "string")
          : [];
    return linked((l) => l.role === "on") ?? listed;
  }
  const map = entry?.kind === "overlay" && entry.label ? entry.label.of : fold.labels.get(id);
  if (map) return [map];
  if (kind === "overlay") {
    const base = entry?.kind === "overlay" ? entry.base : state?.base;
    return linked((l) => l.role === "base") ?? (base ? [base] : []);
  }
  if (kind === "base") {
    const isBase = (other: string) =>
      (catalog.find((e) => e.id === other)?.kind ?? fold.byId.get(other)?.kind) === "base";
    const from = entry?.kind === "base" ? entry.from : undefined;
    return linked((l) => isBase(l.id)) ?? (from ? [from] : []);
  }
  return [];
}

/** A label overlay's map, else the output itself: what a version of it is published as. */
const holderOf = (catalog: OutputCatalog, fold: OutputsFold, id: string) => {
  const entry = catalog.find((e) => e.id === id);
  return (entry?.kind === "overlay" && entry.label?.of) || fold.labels.get(id) || id;
};

/**
 * The chain `value` rests on, one array per step back, nearest first; an output reached twice
 * stays at its first step. A label is "reported" once its map is in: the map carries its items.
 */
export function restsOnChain(
  catalog: OutputCatalog,
  fold: OutputsFold,
  value: string,
): ChainLink[][] {
  const seen = new Set([value]);
  const levels: ChainLink[][] = [];
  let at = [value];
  while (at.length > 0) {
    const next = [
      ...new Set(at.flatMap((id) => stepBack(catalog, fold, id)).filter((id) => !seen.has(id))),
    ];
    for (const id of next) seen.add(id);
    if (next.length === 0) break;
    levels.push(
      next.map((id) => {
        const holder = holderOf(catalog, fold, id);
        const state = fold.byId.get(holder);
        if (!state?.latest) return { id };
        const status = holder === id || state.outOfDate ? state.status : "reported";
        return { id, status };
      }),
    );
    at = next;
  }
  return levels;
}
