/**
 * The grid a review task is shown on, and what the viewer draws there, from the run's published
 * blocks: blocks share a grid when their volumes share a `gridId`, and every position comes from
 * the run (crop offsets, the volume's own affine). Nothing is aligned or resampled here, and a
 * block on another grid is listed, never drawn.
 */
import type { Focus, ReviewAssets, ReviewTask, Revision, Volume } from "@voluma/contracts/review";
import { readLevel } from "./planes";
import type { GridMesh, GridScene, Overlay, ZarrSource, Zyx } from "./scene";

/** The Structures panel's settings, by structure id; opacity in percent. */
export type StructureDisplay = Record<string, { visible: boolean; opacity: number }>;

/** Label values of a labels volume on the grid. */
export type FocusLabels = { source: ZarrSource; labels: number[] };

export type TaskGrid =
  | { state: "none" | "preparing" | "failed"; message: string }
  | {
      state: "ready";
      /** The grid's id: a new one remounts the viewer. */
      gridId: string;
      name: string;
      scene: GridScene;
      /** Where the focused check is, when the run says. */
      focus?: Zyx;
      /** Else the focused labels, whose middle `labelsMiddle` finds. */
      focusLabels?: FocusLabels;
      /** What the task names that isn't drawn here, and why. */
      notes: string[];
    };

type Input = {
  revision: Revision;
  task: ReviewTask;
  assets: Record<string, ReviewAssets>;
  display: StructureDisplay;
  focus?: Focus;
  /** The URL prefix (ending in "/") of a file's converted assets. */
  assetBase(sha256: string): string;
  /** A CSS custom property's value: colours come from the design tokens. */
  token(name: string): string;
};

export function taskGrid({
  revision,
  task,
  assets,
  display,
  focus,
  assetBase,
  token,
}: Input): TaskGrid {
  const volumes = new Map(revision.volumes.map((v) => [v.id, v]));
  const blocks = new Map<string, { volumeId: string | null }>([
    ...revision.volumes.map((v) => [v.id, { volumeId: v.id }] as const),
    ...[...revision.structures, ...revision.surfaces, ...revision.annotations].map(
      (b) => [b.id, b] as const,
    ),
  ]);
  const gridOf = (id: string) => {
    const volumeId = blocks.get(id)?.volumeId;
    return volumeId ? volumes.get(volumeId)?.gridId : undefined;
  };
  // What the task shows: the focused check's blocks, what its numbers are measured on and
  // drawn with, then the blocks it reported itself.
  const measured = [...task.measurements, ...task.scores];
  const named = unique([
    ...(focus?.on ?? []),
    ...measured.flatMap((m) => m.on),
    ...measured.flatMap((m) => m.context),
    ...[...blocks.keys()].filter((id) => id.startsWith(`${task.id}/`)),
  ]);
  // The scan's grid is the first image volume's; a focus point or box is in its voxels.
  const scanGrid = revision.volumes.find((v) => v.kind === "image")?.gridId;
  const gridId =
    mostCommon((focus?.on ?? []).map(gridOf)) ?? mostCommon(named.map(gridOf)) ?? scanGrid;
  const image = revision.volumes.find(
    (v) => v.gridId === gridId && v.kind === "image" && v.data?.format === "npy",
  );
  if (!gridId || !image || image.data?.format !== "npy")
    return { state: "none", message: "This task has no image to show." };
  const imageAssets = assets[image.data.sha256];
  if (!imageAssets) return { state: "preparing", message: `Preparing ${image.name} for viewing…` };
  if (imageAssets.state === "failed")
    return {
      state: "failed",
      message: `Couldn't prepare ${image.name} for viewing: ${imageAssets.error}`,
    };

  const notes = { preparing: [] as string[], failed: [] as string[], elsewhere: [] as string[] };
  const ready = (sha256: string, name: string) => {
    const a = assets[sha256];
    if (a?.state === "ready") return a;
    notes[a ? "failed" : "preparing"].push(name);
    return null;
  };
  const focused = new Set(focus?.on ?? []);
  // Hidden is opacity 0: the mesh stays loaded for when it's shown again.
  const paint = (id: string, color: string) => {
    if (focused.has(id)) return { color: token("--check-outline"), opacity: 1 };
    const d = display[id] ?? { visible: true, opacity: 100 };
    return { color, opacity: d.visible ? d.opacity / 100 : 0 };
  };
  const overlays: Overlay[] = [];
  const meshes: GridMesh[] = [];
  const mesh = (
    sha256: string,
    m: { path: string; vertices: number; indices: number },
    name: string,
    offsetZyx: Zyx,
    look: { color: string; opacity: number },
  ): GridMesh => ({
    id: `${sha256}/${m.path}`,
    name,
    url: `${assetBase(sha256)}${m.path}`,
    vertices: m.vertices,
    indices: m.indices,
    offsetZyx,
    ...look,
  });

  // Structures: a named labels volume brings every structure on it.
  const structureIds = new Set(named);
  for (const s of revision.structures)
    if (s.volumeId && named.includes(s.volumeId) && volumes.get(s.volumeId)?.kind === "labels")
      structureIds.add(s.id);
  const structures = revision.structures.filter((s) => structureIds.has(s.id) && s.voxels);
  const labelsOn = new Map<Volume, { label: number; id: string; name: string }[]>();
  let colour = 0;
  const nextColour = () => token(`--label-${(colour++ % 12) + 1}`);
  for (const s of structures) {
    const volume = s.volumeId ? volumes.get(s.volumeId) : undefined;
    if (!volume || !s.voxels) continue;
    if (volume.gridId !== gridId) {
      notes.elsewhere.push(s.name);
      continue;
    }
    if ("label" in s.voxels) {
      labelsOn.set(volume, [
        ...(labelsOn.get(volume) ?? []),
        { label: s.voxels.label, id: s.id, name: s.name },
      ]);
      continue;
    }
    const { mask, offsetZyx } = s.voxels;
    const look = paint(s.id, nextColour());
    const a = ready(mask.sha256, s.name);
    if (!a) continue;
    if (look.opacity > 0)
      overlays.push({
        id: s.id,
        name: s.name,
        base: assetBase(mask.sha256),
        levels: a.levels,
        offsetZyx,
        ...look,
      });
    meshes.push(...a.meshes.map((m) => mesh(mask.sha256, m, s.name, offsetZyx, look)));
  }
  let focusLabels: FocusLabels | undefined;
  for (const [volume, labels] of labelsOn) {
    if (volume.data?.format !== "npy") {
      notes.failed.push(...labels.map((l) => l.name));
      continue;
    }
    const sha256 = volume.data.sha256;
    const a = ready(sha256, volume.name);
    if (!a) continue;
    const wanted = labels.filter((l) => focused.has(l.id)).map((l) => l.label);
    if (wanted.length && !focusLabels)
      focusLabels = { source: { base: assetBase(sha256), levels: a.levels }, labels: wanted };
    const looks = new Map(
      labels.map((l) => [l.label, paint(l.id, token(`--label-${((l.label - 1) % 12) + 1}`))]),
    );
    const shown = [...looks].filter(([, look]) => look.opacity > 0);
    if (shown.length)
      overlays.push({
        id: volume.id,
        name: volume.name,
        base: assetBase(sha256),
        levels: a.levels,
        offsetZyx: [0, 0, 0],
        color: Object.fromEntries(shown.map(([label, look]) => [label, look.color])),
        opacity: Object.fromEntries(shown.map(([label, look]) => [label, look.opacity])),
      });
    for (const m of a.meshes) {
      const look = m.label === undefined ? undefined : looks.get(m.label);
      const l = labels.find((x) => x.label === m.label);
      if (look && l) meshes.push(mesh(sha256, m, l.name, [0, 0, 0], look));
    }
  }
  // Surfaces: their meshes (the slices' trace of a surface is still to come).
  for (const s of revision.surfaces) {
    if (!named.includes(s.id)) continue;
    if (volumes.get(s.volumeId)?.gridId !== gridId) {
      notes.elsewhere.push(s.name);
      continue;
    }
    const look = paint(s.id, nextColour());
    const a = ready(s.heights.sha256, s.name);
    if (a) meshes.push(...a.meshes.map((m) => mesh(s.heights.sha256, m, s.name, [0, 0, 0], look)));
  }

  return {
    state: "ready",
    gridId,
    name: image.name,
    scene: {
      shapeZyx: image.shapeZyx,
      spacingZyx: spacingZyx(image),
      image: { base: assetBase(image.data.sha256), levels: imageAssets.levels },
      overlays,
      meshes,
    },
    focus: focus && focusPoint(focus, revision, image, gridId === scanGrid),
    focusLabels,
    notes: [
      notes.preparing.length && `Still preparing: ${notes.preparing.join(", ")}.`,
      notes.failed.length && `Couldn't prepare: ${notes.failed.join(", ")}.`,
      notes.elsewhere.length && `On another grid, not shown here: ${notes.elsewhere.join(", ")}.`,
    ].filter((n): n is string => !!n),
  };
}

/**
 * The middle of the labels' bounding box, in grid voxels, from the coarsest level (one or a few
 * chunks): good for centring the crosshair, not for measuring. Undefined if no voxel has them.
 */
export async function labelsMiddle(
  { source, labels }: FocusLabels,
  signal: AbortSignal,
): Promise<Zyx | undefined> {
  const level = source.levels.at(-1);
  if (!level) return;
  const { data, shape } = await readLevel(source.base, level.path, signal);
  const [nz = 0, ny = 0, nx = 0] = shape;
  const wanted = new Set(labels);
  const lo = [nz, ny, nx];
  const hi = [-1, -1, -1];
  for (let z = 0, i = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++, i++) {
        if (!wanted.has(data[i] as number)) continue;
        const p = [z, y, x];
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a]!, p[a]!);
          hi[a] = Math.max(hi[a]!, p[a]!);
        }
      }
  if (hi[0]! < 0) return;
  // A level voxel i covers source voxels [i·s, (i+1)·s).
  return [0, 1, 2].map((a) => {
    const s = level.scaleZyx[a]!;
    return Math.floor(((lo[a]! + hi[a]! + 1) * s) / 2);
  }) as unknown as Zyx;
}

/** mm per voxel along z, y, x: the norms of the affine's x, y and z columns, reversed. */
function spacingZyx(volume: Volume): Zyx {
  const norm = (j: number) => Math.hypot(...volume.affine.slice(0, 3).map((row) => row[j]!));
  return [norm(2), norm(1), norm(0)];
}

/**
 * Where a check points on this grid: its point or box (scan voxels, so only on the scan's grid),
 * else the middle of its cropped masks, else of its annotations (world mm, through the grid's
 * own affine). A labels structure gives no point: its extent isn't in the run's data.
 */
function focusPoint(
  focus: Focus,
  revision: Revision,
  image: Volume,
  onScanGrid: boolean,
): Zyx | undefined {
  const clamp = (p: number[]) =>
    p.map((n, i) => Math.max(0, Math.min(image.shapeZyx[i]! - 1, Math.round(n)))) as unknown as Zyx;
  const middle = (boxes: { min: number[]; max: number[] }[]) =>
    boxes.length
      ? clamp(
          [0, 1, 2].map(
            (i) =>
              (Math.min(...boxes.map((b) => b.min[i]!)) +
                Math.max(...boxes.map((b) => b.max[i]!))) /
              2,
          ),
        )
      : undefined;
  if (onScanGrid && focus.point) return clamp(focus.point);
  if (onScanGrid && focus.box) return middle([focus.box]);
  const sameGrid = (volumeId: string | null) =>
    revision.volumes.find((v) => v.id === volumeId)?.gridId === image.gridId;
  const masks = revision.structures.flatMap((s) => {
    const v = s.voxels;
    if (!focus.on.includes(s.id) || !sameGrid(s.volumeId) || !v || !("mask" in v)) return [];
    return [{ min: [...v.offsetZyx], max: v.offsetZyx.map((o, i) => o + v.mask.shapeZyx[i]! - 1) }];
  });
  if (masks.length) return middle(masks);
  const points = revision.annotations
    .filter((a) => focus.on.includes(a.id) && sameGrid(a.volumeId))
    .flatMap((a) => (a.kind === "point" ? [a.position] : [a.a, a.b]))
    .map((world) => voxelOf(image, world));
  return middle(points.map((p) => ({ min: p, max: p })));
}

/** World mm to voxel (z, y, x): the affine's columns are orthogonal, so each is a projection. */
function voxelOf(volume: Volume, world: readonly number[]): number[] {
  const m = volume.affine;
  const d = [0, 1, 2].map((r) => world[r]! - m[r]![3]!);
  const xyz = [0, 1, 2].map((j) => {
    const col = [m[0][j]!, m[1][j]!, m[2][j]!];
    return (
      (col[0]! * d[0]! + col[1]! * d[1]! + col[2]! * d[2]!) /
      (col[0]! ** 2 + col[1]! ** 2 + col[2]! ** 2)
    );
  });
  return [xyz[2]!, xyz[1]!, xyz[0]!];
}

const unique = <T>(xs: T[]) => [...new Set(xs)];

/** The most frequent defined value, the earliest on a tie. */
function mostCommon(xs: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const x of xs) if (x) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | undefined;
  for (const [x, n] of counts) if (best === undefined || n > counts.get(best)!) best = x;
  return best;
}
