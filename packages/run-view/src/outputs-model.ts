/**
 * The outputs-first review of a run of the agent loop (`harness: agents`): its final outputs in
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
  needingYou,
  type OutputState,
  type OutputsFold,
  type OutputVersion,
  outputsIn,
} from "@voluma/contracts/output-fold";
import { outputsPrefix } from "@voluma/contracts/r2";
import type {
  Annotation,
  Focus,
  ReviewAssets,
  Structure,
  Surface,
  Volume,
} from "@voluma/contracts/review";
import { type ChainLink, chainOf, type TrailRow, trailOf } from "./outputs-trail";
import { formatNumber } from "./run-model";

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
  /** The final outputs that need a person (`needingYou`): what Needs you counts. */
  needing: Set<string>;
  /** Final outputs with a version, of all final outputs. */
  progress: { done: number; total: number };
};

/** What the input review's scene needs: the blocks it draws from. */
export type OutputBlocks = {
  volumes: Volume[];
  structures: Structure[];
  surfaces: Surface[];
  annotations: Annotation[];
};

/** A run's own words for an output: the catalog's name, else its id as words. */
export function outputName(catalog: OutputCatalog, id: string): string {
  const named = catalog.find((e) => e.id === id)?.name;
  if (named) return named;
  const own = id.split("/").at(-1) ?? id;
  const words = own.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A UCUM unit as a value shows it (`unitAsWritten`); a dimensionless `1` shows nothing. */
export const unitText = (ucum: string): string => (ucum === "1" ? "" : unitAsWritten(ucum));

/** The To check items version `v` of output `id` raised; `key` is the URL's `item`. */
export function itemsOfVersion(id: string, v: OutputVersion): OutputItem[] {
  return v.toCheck.map((t, item) => ({
    key: `${id}/${v.version}/${item}`,
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
  // The bundled catalog's entry, else the run's own (its final list's, written from the catalog
  // of the run's commit, or a worker's description of an output the workflow does not declare).
  const entry = catalog.find((e) => e.id === state.id);
  const loose = state.entry;
  const value = entry?.kind === "value" ? entry : undefined;
  const description =
    entry?.description ?? (typeof loose?.description === "string" ? loose.description : undefined);
  const latest = state.latest;
  const links = (role: string) =>
    latest?.madeFrom.filter((l) => l.role === role).map((l) => l.id) ?? [];
  const on = [...new Set([...(value?.on ?? strings(loose?.on)), ...links("on")])];
  const trail = trailOf(fold, catalog, state.id);
  return {
    id: state.id,
    name: outputName(catalog, state.id),
    ...(description && { description }),
    state,
    ...(latest?.value && {
      value: { text: formatNumber(latest.value.number), unit: unitText(latest.value.unit) },
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
    needing: needingYou(fold),
    progress: outputsIn(fold),
  };
}

/**
 * What the centre shows besides the selected value: `opened`, else while the run goes `standIn`,
 * the nearest published link of the value's chain when the value is pending. One opened from Other
 * outputs stays open after the run ends (until Esc): the whole run opens outputs the same way.
 */
export function inViewOf(
  review: OutputsReview,
  selected: OutputRow | undefined,
  opened: OutputRow | undefined,
  live: boolean,
): { trailOpen?: OutputRow; standIn?: OutputRow } {
  if (opened && opened.id !== selected?.id) return { trailOpen: opened };
  if (!live || selected?.state.status !== "pending") return {};
  const standIn = selected.chain
    .flat()
    .map((l) => review.rows.get(l.id))
    .find((r) => r?.state.latest);
  return standIn ? { standIn } : {};
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
const isRow = (r: unknown): r is [number, number, number, number] =>
  Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number");
const affineOf = (d: Detail): Volume["affine"] =>
  Array.isArray(d.affine) && d.affine.length === 4 && d.affine.every(isRow)
    ? (d.affine as Volume["affine"])
    : IDENTITY;
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
  const blocks: OutputBlocks = { volumes: [], structures: [], surfaces: [], annotations: [] };
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
      affine: affineOf(d),
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
