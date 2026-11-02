/**
 * The outputs-first review of a run of the agent loop (`harness: agents`): its final outputs in
 * their sections, each with its value, status and To check items, and the blocks that draw an
 * output in the scan review's 3D scene. Built from the output fold (`outputsFold`, live from the
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
import type { OutputCatalog, OutputEntry } from "@voluma/contracts/output-catalog";
import type { OutputState, OutputsFold, OutputVersion } from "@voluma/contracts/output-fold";
import { outputsPrefix } from "@voluma/contracts/r2";
import type {
  Annotation,
  Focus,
  ReviewAssets,
  Structure,
  Surface,
  Volume,
} from "@voluma/contracts/review";
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
  /** The open and resolved items of its latest version and of what that was made from. */
  items: OutputItem[];
};

export type OutputsReview = {
  sections: { title: string; rows: OutputRow[] }[];
  /** Published outputs the workflow does not declare (a worker's own mask). */
  undeclared: OutputRow[];
  rows: Map<string, OutputRow>;
  /** Unresolved items across every output's latest version. */
  open: number;
  /** Final outputs with a version, of all final outputs. */
  progress: { done: number; total: number };
};

/** What the scan review's scene needs: the blocks it draws from. */
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

const SUPERSCRIPT: Record<string, string> = { "2": "²", "3": "³", "-1": "⁻¹", "-2": "⁻²" };

/**
 * A UCUM unit as people write it: `mm3` → `mm³`, `[hnsf'U]` → `HU`, `um` → `µm`; annotations in
 * braces drop out, and a dimensionless `1` shows nothing.
 */
export function unitText(ucum: string): string {
  if (ucum === "1") return "";
  return ucum
    .replaceAll("[hnsf'U]", "HU")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\bu(?=[mgLl])/g, "µ")
    .replace(
      /([A-Za-zµ])(-?\d)/g,
      (_, unit: string, power: string) => unit + (SUPERSCRIPT[power] ?? power),
    )
    .replaceAll(".", "·")
    .trim();
}

/** The latest versions an output's latest version was made from, transitively, itself first. */
function trailOf(fold: OutputsFold, id: string): { output: string; v: OutputVersion }[] {
  const seen = new Set<string>();
  const out: { output: string; v: OutputVersion }[] = [];
  const walk = (at: string) => {
    if (seen.has(at)) return;
    seen.add(at);
    const latest = fold.byId.get(at)?.latest;
    if (!latest) return;
    out.push({ output: at, v: latest });
    for (const link of latest.madeFrom) walk(link.id);
  };
  walk(id);
  return out;
}

function itemsOf(fold: OutputsFold, id: string): OutputItem[] {
  return trailOf(fold, id).flatMap(({ output, v }) => {
    return v.toCheck.map((t, item) => ({
      key: `${output}/${v.version}/${item}`,
      output,
      version: v.version,
      item,
      title: t.title,
      ...(t.focus && { focus: t.focus }),
      resolved: t.resolved !== undefined,
    }));
  });
}

/** The catalog entry, else the run's final list's (a final output added from the catalog of its own commit). */
const entryOf = (catalog: OutputCatalog, state: OutputState): OutputEntry | undefined =>
  catalog.find((e) => e.id === state.id) ?? state.entry;

function rowOf(fold: OutputsFold, catalog: OutputCatalog, state: OutputState): OutputRow {
  const entry = entryOf(catalog, state);
  const value = state.latest?.value;
  const links = (role: string) =>
    state.latest?.madeFrom.filter((l) => l.role === role).map((l) => l.id) ?? [];
  const valueEntry = entry?.kind === "value" ? entry : undefined;
  return {
    id: state.id,
    name: outputName(catalog, state.id),
    ...(entry?.description && { description: entry.description }),
    state,
    ...(value && { value: { text: formatNumber(value.number), unit: unitText(value.unit) } }),
    provisional: state.latest?.provisional === true || valueEntry?.provisional === true,
    on: [...new Set([...(valueEntry?.on ?? []), ...links("on")])],
    context: [...new Set([...(valueEntry?.context ?? []), ...links("context")])],
    items: itemsOf(fold, state.id),
  };
}

export function outputsReview(fold: OutputsFold, catalog: OutputCatalog): OutputsReview {
  const rows = new Map(fold.outputs.map((o) => [o.id, rowOf(fold, catalog, o)]));
  const sections: OutputsReview["sections"] = (fold.list?.sections ?? []).map((s) => ({
    title: s.title,
    rows: s.outputs.flatMap((o) => rows.get(o.id) ?? []),
  }));
  const final = fold.outputs.filter((o) => o.final);
  const open = new Set(
    fold.outputs.flatMap((o) =>
      (o.latest?.toCheck ?? []).flatMap((t, i) => (t.resolved ? [] : [`${o.id}/${i}`])),
    ),
  ).size;
  return {
    sections,
    undeclared: fold.outputs.filter((o) => !o.declared).flatMap((o) => rows.get(o.id) ?? []),
    rows,
    open,
    progress: { done: final.filter((o) => o.latest).length, total: final.length },
  };
}

/** Whether a run's log is the agent loop's: it has final outputs or a published version. */
export const isAgentsRun = (fold: OutputsFold) =>
  fold.list !== undefined || fold.outputs.some((o) => o.latest);

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
function detailOf(v: OutputVersion): Detail {
  const raw = (v as { detail?: unknown }).detail;
  return raw && typeof raw === "object" ? (raw as Detail) : {};
}

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
        key: key(v, file.path),
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
          mask: { key: key(v, file.path), sha256, shapeZyx: shapeOf(assets, sha256) },
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
        heights: { key: key(v, file.path), sha256 },
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
