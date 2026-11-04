/**
 * The outputs-first review of a run: its final outputs in
 * their sections, each with its value, status and To check items, and the blocks that draw an
 * output in the input review's 3D scene. Built from the output fold (`outputsFold`, live from the
 * run's events) and the workflow's catalog (`outputs.yaml`, bundled: names, label maps, shapes).
 * Rules: the agent-model design's `review.md` ("Layout") and `outputs.md` ("Kinds", "Status").
 *
 * A scene is a base with overlays on it. Each output's latest version becomes one block: a base an
 * image volume, a labels overlay a labels volume (each catalog label of it a structure), a mask a
 * structure, a surface a surface, a point or line an annotation. What the converter and the viewer
 * need beyond the files comes from the version's `detail`: `affine` (4x4, voxel to mm; identity
 * when absent), `offsetZyx` (a cropped mask's place), `axis` (a surface's), `points` (a point or
 * line overlay's ends, world mm). Grid shapes come from the converted levels.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { type OutputCatalog, unitAsWritten } from "@voluma/contracts/output-catalog";
import {
  itemKey,
  type OutputState,
  type OutputsFold,
  type OutputVersion,
  outputsIn,
} from "@voluma/contracts/output-fold";
import { outputsPrefix } from "@voluma/contracts/r2";
import type {
  Annotation,
  Focus,
  Grid,
  ReviewAssets,
  Structure,
  Surface,
  Volume,
} from "@voluma/contracts/review";
import { affineIn } from "@voluma/contracts/ruler";
import { type ChainLink, chainOf, type TrailRow, trailOf } from "./outputs-trail";

/** One To check item, on the version it was raised on. */
export type OutputItem = {
  /** `output/version/index`: unique in the run. */
  key: string;
  output: string;
  version: number;
  item: number;
  title: string;
  focus?: Focus;
  /** Accepted or corrected by a person. */
  resolved: boolean;
};

export type OutputRow = {
  id: string;
  name: string;
  description?: string;
  state: OutputState;
  /** A value's number, formatted, and its unit for people (`mm³`, `HU`). */
  value?: { text: string; unit: string };
  provisional: boolean;
  /** The overlays a value is measured on and drawn with, by id. */
  on: string[];
  context: string[];
  /** What its latest version was made from, recursively (`trailOf`); the root alone before one. */
  trail: TrailRow[];
  /** A final output's chain, nearest first (`chainOf`); empty for any other. */
  chain: ChainLink[][];
  /** The open and resolved items of its latest version and of what that was made from. */
  items: OutputItem[];
};

export type OutputsReview = {
  sections: { title: string; rows: OutputRow[] }[];
  /** Published outputs the workflow does not declare (a worker's own mask). */
  undeclared: OutputRow[];
  rows: Map<string, OutputRow>;
  /**
   * Published outputs that are neither final nor on a final output's chain (each shows there), nor
   * undeclared: what "Other outputs so far" lists while the run goes.
   */
  others: OutputRow[];
  /** The open To check items a person can answer (`OutputsFold.openItems`): what To check counts. */
  open: Set<string>;
  /** Final outputs with a version, of all final outputs. */
  progress: { done: number; total: number };
};

/** What the input review's scene needs: the blocks it draws from. */
export type OutputBlocks = {
  volumes: Volume[];
  structures: Structure[];
  surfaces: Surface[];
  annotations: Annotation[];
  /** Every grid the run published, one per grid hash: bases first, then frames (file outputs). */
  grids: Grid[];
};

/** A run's own words for an output: the catalog's name, else its id as words. */
export function outputName(catalog: OutputCatalog, id: string): string {
  const named = catalog.find((e) => e.id === id)?.name;
  if (named) return named;
  const own = id.split("/").at(-1) ?? id;
  const words = own.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Up to three significant digits (whole numbers from 1,000). */
const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US", {
    ...(Math.abs(value) >= 1000 ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 3 }),
  }).format(value);

/** The To check items version `v` of output `id` raised; `key` is the URL's `item`. */
export function itemsOfVersion(id: string, v: OutputVersion): OutputItem[] {
  return v.toCheck.map((t, item) => ({
    key: itemKey(id, v.version, item),
    output: id,
    version: v.version,
    item,
    title: t.title,
    ...(t.focus && { focus: t.focus }),
    resolved: t.resolved !== undefined,
  }));
}

const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];

function rowOf(fold: OutputsFold, catalog: OutputCatalog, state: OutputState): OutputRow {
  // The description is the run's own (its final list's, written from the catalog of the run's
  // commit, or a worker's for an output the workflow does not declare), since it says how this
  // run measured the number; the bundled catalog's only when the run has none.
  const entry = catalog.find((e) => e.id === state.id);
  const loose = state.entry;
  const value = entry?.kind === "value" ? entry : undefined;
  const description =
    (typeof loose?.description === "string" ? loose.description : undefined) ?? entry?.description;
  const latest = state.latest;
  const links = (role: string) =>
    latest?.madeFrom.filter((l) => l.role === role).map((l) => l.id) ?? [];
  const on = [...new Set([...(value?.on ?? strings(loose?.on)), ...links("on")])];
  const trail = trailOf(fold, state.id);
  return {
    id: state.id,
    name: outputName(catalog, state.id),
    ...(description && { description }),
    state,
    ...(latest?.value && {
      value: { text: formatNumber(latest.value.number), unit: unitAsWritten(latest.value.unit) },
    }),
    provisional:
      latest?.provisional === true || (value?.provisional ?? loose?.provisional === true),
    on,
    context: [...new Set([...(value?.context ?? strings(loose?.context)), ...links("context")])],
    trail,
    chain: state.final ? chainOf(fold, catalog, state.id, on) : [],
    items: trail.flatMap(({ id: output, state }) =>
      state?.latest ? itemsOfVersion(output, state.latest) : [],
    ),
  };
}

/** The items of `row`'s trail still open: the value's own and those of what it rests on. */
export const openItemsOf = (row: OutputRow): OutputItem[] => row.items.filter((i) => !i.resolved);

/**
 * What "only To check" lists: the rows whose own items are open, plus a row for each open item no
 * listed row owns (a label map the values rest on), so one open item is one row, not every value
 * that rests on it.
 */
export function rowsToCheck(review: OutputsReview): { listed: OutputRow[]; behind: OutputRow[] } {
  const listed = [...review.sections.flatMap((s) => s.rows), ...review.undeclared];
  const owns = (r: OutputRow) => openItemsOf(r).some((i) => i.output === r.id);
  const shown = new Set(listed.map((r) => r.id));
  const behind = new Set<string>();
  for (const r of listed)
    for (const i of openItemsOf(r)) if (!shown.has(i.output)) behind.add(i.output);
  return {
    listed: listed.filter(owns),
    behind: [...behind].flatMap((id) => review.rows.get(id) ?? []),
  };
}

export function outputsReview(fold: OutputsFold, catalog: OutputCatalog): OutputsReview {
  const rows = new Map(fold.outputs.map((o) => [o.id, rowOf(fold, catalog, o)]));
  const sections: OutputsReview["sections"] = (fold.list?.sections ?? []).map((s) => ({
    title: s.title,
    rows: s.outputs.flatMap((o) => rows.get(o.id) ?? []),
  }));
  const onChain = new Set(
    [...rows.values()].flatMap((r) => r.chain.flatMap((step) => step.map((l) => l.id))),
  );
  return {
    sections,
    undeclared: fold.outputs.filter((o) => !o.declared).flatMap((o) => rows.get(o.id) ?? []),
    rows,
    others: [...rows.values()].filter(
      (r) => r.state.latest && !r.state.final && r.state.declared && !onChain.has(r.id),
    ),
    open: fold.openItems,
    progress: outputsIn(fold),
  };
}

/**
 * What the centre shows besides the selected value: `opened`, else while the run goes `standIn`,
 * the nearest published link of the value's chain when the value is pending, else (`soFar`) the
 * output published last whose whole scene `blocks` can draw (the scan, from intake on), so a run
 * going shows what it has made as soon as it has. One opened from Other outputs stays open after the run ends (until
 * Esc): the whole run opens outputs the same way.
 */
export function inViewOf(
  review: OutputsReview,
  selected: OutputRow | undefined,
  opened: OutputRow | undefined,
  live: boolean,
  blocks: OutputBlocks,
): { trailOpen?: OutputRow; standIn?: OutputRow; soFar?: boolean } {
  if (opened && opened.id !== selected?.id) return { trailOpen: opened };
  if (!live || (selected && selected.state.status !== "pending")) return {};
  const onChain = selected?.chain
    .flat()
    .map((l) => review.rows.get(l.id))
    .find((r) => r?.state.latest);
  if (onChain) return { standIn: onChain };
  const drawn = [...review.rows.values()]
    .filter((r) => {
      const shown = shownOf(r);
      return !!r.state.latest && shown.length > 0 && undrawn(blocks, shown).length === 0;
    })
    .sort((a, b) => (b.state.latest?.at ?? "").localeCompare(a.state.latest?.at ?? ""))[0];
  return drawn ? { standIn: drawn, soFar: true } : {};
}

// ---------------------------------------------------------------------------------------------
// The scene

/** The run's converted review assets by source sha256, as `fold` collects them; absent: preparing. */
export function reviewAssetsOf(events: readonly RunEvent[]): Record<string, ReviewAssets> {
  const assets: Record<string, ReviewAssets> = {};
  for (const e of events)
    if (e.type === "assets.ready") {
      const { sourceSha256, ...manifest } = e.payload;
      assets[sourceSha256] = { state: "ready", ...manifest };
    } else if (e.type === "assets.failed")
      assets[e.payload.sourceSha256] = { state: "failed", error: e.payload.error };
  return assets;
}

type Detail = {
  /** The sidecar's grid hash (not a block's `gridId`, which is its base's output id). */
  gridId?: string;
  affine?: number[][];
  offsetZyx?: number[];
  axis?: number;
  points?: number[][];
  dtype?: string;
  unit?: string;
};

/** What review reads of a version's `detail`; anything malformed reads as absent. */
const detailOf = (v: OutputVersion): Detail => (v.detail ?? {}) as Detail;

const IDENTITY: Volume["affine"] = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const zyx = (p: unknown): [number, number, number] | undefined =>
  Array.isArray(p) && p.length === 3 && p.every((n) => Number.isInteger(n) && n >= 0)
    ? (p as [number, number, number])
    : undefined;
const xyz = (p: unknown): [number, number, number] | undefined =>
  Array.isArray(p) && p.length === 3 && p.every((n) => typeof n === "number")
    ? (p as [number, number, number])
    : undefined;

/** The finest converted level's shape; a placeholder until the file is converted. */
const shapeOf = (assets: Record<string, ReviewAssets>, sha256: string): [number, number, number] =>
  (assets[sha256]?.state === "ready" && assets[sha256].levels[0]?.shapeZyx) || [1, 1, 1];

/** How an overlay is stored: its catalog shape, else (an undeclared one) none known. */
const shapeOfEntry = (catalog: OutputCatalog, id: string) => {
  const e = catalog.find((x) => x.id === id);
  return e?.kind === "overlay" ? e.shape : undefined;
};

/**
 * The grids the run published: every base or file output whose detail carries the sidecar's
 * `gridId` (its hash) and an affine, the first to publish a hash naming it. A base claims its hash
 * before a file on the same grid (the scan's hu.json), so the scan is never named for its header.
 */
function publishedGrids(fold: OutputsFold, catalog: OutputCatalog): Grid[] {
  const seen = new Set<string>();
  return (["base", "file"] as const).flatMap((kind) =>
    fold.outputs.flatMap((o): Grid[] => {
      const v = o.latest;
      const d = v && o.kind === kind ? detailOf(v) : undefined;
      const affine = affineIn(d);
      if (!v || !affine || typeof d?.gridId !== "string" || seen.has(d.gridId)) return [];
      seen.add(d.gridId);
      return [{ id: o.id, name: outputName(catalog, o.id), by: v.by, kind, affine }];
    }),
  );
}

/**
 * Every output's latest version as a block of the scene, on the grid of its base (a block's
 * `gridId` is its base's id). An output whose version can't be drawn (a file, a value, a point
 * with no `points`) has no block.
 */
export function outputBlocks(
  fold: OutputsFold,
  catalog: OutputCatalog,
  runId: string,
  assets: Record<string, ReviewAssets>,
): OutputBlocks {
  const blocks: OutputBlocks = {
    volumes: [],
    structures: [],
    surfaces: [],
    annotations: [],
    grids: publishedGrids(fold, catalog),
  };
  const key = (v: OutputVersion, file: string) => `${outputsPrefix(runId)}${v.path}/${file}`;
  for (const o of fold.outputs) {
    const v = o.latest;
    const file = v?.files[0];
    if (!v || !file) continue;
    const name = outputName(catalog, o.id);
    const d = detailOf(v);
    const sha256 = file.sha256;
    const shape = o.kind === "overlay" ? shapeOfEntry(catalog, o.id) : undefined;
    const volume = (kind: Volume["kind"], gridId: string): Volume => ({
      id: o.id,
      name,
      kind,
      shapeZyx: shapeOf(assets, sha256),
      affine: affineIn(d) ?? IDENTITY,
      unit: typeof d.unit === "string" ? d.unit : null,
      gridId,
      data: {
        format: "npy",
        key: key(v, file.name),
        sha256,
        dtype: kind === "labels" ? "uint16" : "float32",
      },
    });
    if (o.kind === "base") {
      blocks.volumes.push(volume("image", o.id));
      continue;
    }
    if (o.kind !== "overlay" || !o.base) continue;
    if (shape === "labels") {
      blocks.volumes.push(volume("labels", o.base));
      for (const e of catalog)
        if (e.kind === "overlay" && e.label?.of === o.id)
          blocks.structures.push({
            id: e.id,
            name: e.name,
            volumeId: o.id,
            voxels: { label: e.label.value },
            missing: null,
          });
    } else if (shape === "mask")
      blocks.structures.push({
        id: o.id,
        name,
        volumeId: o.base,
        voxels: {
          mask: { key: key(v, file.name), sha256, shapeZyx: shapeOf(assets, sha256) },
          offsetZyx: zyx(d.offsetZyx) ?? [0, 0, 0],
        },
        missing: null,
      });
    else if (shape === "surface" && (d.axis === 0 || d.axis === 1 || d.axis === 2))
      blocks.surfaces.push({
        id: o.id,
        name,
        volumeId: o.base,
        axis: d.axis,
        heights: { key: key(v, file.name), sha256 },
      });
    else if (shape === "point" || shape === "line") {
      const points = (Array.isArray(d.points) ? d.points : []).map(xyz);
      const [a, b] = points;
      if (shape === "point" && a && points.length === 1)
        blocks.annotations.push({ id: o.id, name, volumeId: o.base, kind: "point", position: a });
      if (shape === "line" && a && b && points.length === 2)
        blocks.annotations.push({ id: o.id, name, volumeId: o.base, kind: "line", a, b });
    }
  }
  return blocks;
}

/** The block ids an output's scene shows: a value's overlays, else the output itself. */
export const shownOf = (row: OutputRow): string[] =>
  row.state.kind === "value" ? [...row.on, ...row.context] : [row.id];

/** The ids `shown` names that `blocks` cannot draw yet, for a note beside the scene. */
export function undrawn(blocks: OutputBlocks, shown: readonly string[]): string[] {
  const have = new Set(
    [...blocks.volumes, ...blocks.structures, ...blocks.surfaces, ...blocks.annotations].map(
      (b) => b.id,
    ),
  );
  return shown.filter((id) => !have.has(id));
}
