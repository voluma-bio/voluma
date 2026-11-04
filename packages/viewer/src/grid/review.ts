/**
 * The grid an output is shown on in review, and what the viewer draws there, from the run's published blocks: blocks share a grid when their volumes
 * share a `gridId`, and every position comes from the run (crop offsets, the volume's own affine).
 * Nothing is resampled here, and a block on another grid is listed, never drawn, with one
 * exception: a grid with no labels of its own (the aligned tibia grid) shows the scan's label
 * meshes in 3D, moved rigidly through the two grids' affines (`placement`).
 * Every output shows the run's labels as context, with its own blocks over them in
 * `--output` and the focused check's in `--check-outline`.
 */
import type {
  Annotation,
  Focus,
  ReviewAssets,
  Structure,
  Surface,
  Volume,
} from "@voluma/contracts/review";
import { toVoxel } from "@voluma/contracts/ruler";
import { readLevel } from "./planes";
import type {
  GridAnnotation,
  GridMesh,
  GridScene,
  Overlay,
  OverlayStyle,
  VoxelBox,
  ZarrSource,
  Zyx,
} from "./scene";

/** How much of a context label mesh shows over the subject's own meshes inside it. */
const CONTEXT_OPACITY = 0.3;
/** How much of a context label shows on the slices while a check singles out something else. */
const DIMMED_OPACITY = 0.35;
/** A context mesh's opacity then: the camera framing a check often sits inside a bone. */
const DIMMED_CONTEXT_OPACITY = 0.12;

/** Label values of a labels volume on the grid; none means every nonzero value. */
export type FocusLabels = { source: ZarrSource; labels: number[] };

export type ReviewGrid =
  | { state: "none" | "preparing" | "failed"; message: string }
  | {
      state: "ready";
      /** The grid's id: a new one remounts the viewer. */
      gridId: string;
      /** The grid's image volume block id: what a mark on this grid names (`Mark.volumeId`). */
      imageId: string;
      name: string;
      scene: GridScene;
      /** Where the focused check is, and the region to frame, when the run's blocks say. */
      focus?: { at: Zyx; box?: VoxelBox };
      /** Else the focused labels, whose extent `labelsBox` finds. */
      focusLabels?: FocusLabels;
      /** What the subject names that isn't drawn here, and why. */
      notes: string[];
      /** What each colour drawn is, in the order drawn: the Segmentation panel lists it. */
      legend: LegendEntry[];
    };

/** How the run's labels and the subject's regions are drawn, as the Segmentation panel sets it. */
export type LabelDisplay = {
  /** Each label in its own colour; off, every context label in `--bone`. */
  colours: boolean;
  /** Of every structure's blend, 0 to 1. */
  opacity: number;
  /** On the slices: filled, or only each region's edge. 3D always shows surfaces. */
  style: "fill" | "outline";
  /** Each structure's own opacity by block id, 0 to 1; absent is 1. */
  structures: Readonly<Record<string, number>>;
  /** Block ids hidden, whatever their opacity. */
  hidden: readonly string[];
};

export const LABELS_START: LabelDisplay = {
  colours: true,
  opacity: 1,
  style: "fill",
  structures: {},
  hidden: [],
};

/**
 * One structure drawn on the grid and its colour: `label` is context in its label colour (or
 * `--bone`), `output` the subject's own region in `--output`, `check` the focused check's in
 * `--check-outline`. `usual` is a label's own colour when the subject or a check recolours it.
 */
export type LegendEntry = {
  id: string;
  name: string;
  color: string;
  as: "label" | "output" | "check";
  usual?: string;
  /** Drawn only in 3D: context borrowed from another grid. */
  only3d?: true;
};

/** The blocks a grid is drawn from, built from output versions (`outputBlocks`, run-view). */
export type Blocks = {
  volumes: Volume[];
  structures: Structure[];
  surfaces: Surface[];
  annotations: Annotation[];
};

type Input = {
  revision: Blocks;
  /** The block ids the subject shows, before the focused check's. */
  shown: readonly string[];
  assets: Record<string, ReviewAssets>;
  display: LabelDisplay;
  focus?: Focus;
  /** The URL prefix (ending in "/") of a file's converted assets. */
  assetBase(sha256: string): string;
  /** A CSS custom property's value: colours come from the design tokens. */
  token(name: string): string;
};

export function reviewGrid({
  revision,
  shown,
  assets,
  display,
  focus,
  assetBase,
  token,
}: Input): ReviewGrid {
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
  // What the subject shows: the focused check's blocks, then its own.
  const named = unique([...(focus?.on ?? []), ...shown]);
  // The scan's grid is the first image volume's; a focus point or box is in its voxels.
  const scanGrid = revision.volumes.find((v) => v.kind === "image")?.gridId;
  // A check's `volumeId` is a labels volume (a disagreement mask) it points into.
  const focusVolume = focus?.volumeId ? volumes.get(focus.volumeId) : undefined;
  // A check that names something within the anatomy (a label, a mask, an annotation, a place)
  // singles it out: the rest of the labels dim. One naming a whole labels volume is about all of
  // it, and the scan, a surface or an unknown id single nothing out.
  const singling = new Set([...revision.structures, ...revision.annotations].map((b) => b.id));
  const singled =
    !!focus &&
    (!!focus.volumeId || !!focus.point || !!focus.box || focus.on.some((id) => singling.has(id)));
  const gridId =
    mostCommon([...(focus?.on ?? []).map(gridOf), focusVolume?.gridId]) ??
    mostCommon(named.map(gridOf)) ??
    scanGrid;
  const image = revision.volumes.find(
    (v) => v.gridId === gridId && v.kind === "image" && v.data?.format === "npy",
  );
  if (!gridId || !image || image.data?.format !== "npy")
    return { state: "none", message: "There is no image to show this on." };
  const imageAssets = assets[image.data.sha256];
  if (!imageAssets) return { state: "preparing", message: `Preparing ${image.name} for viewing…` };
  if (imageAssets.state === "failed")
    return {
      state: "failed",
      message: `Couldn't prepare ${image.name} for viewing.`,
    };

  const notes = { preparing: [] as string[], failed: [] as string[], elsewhere: [] as string[] };
  const ready = (sha256: string, name: string) => {
    const a = assets[sha256];
    if (a?.state === "ready") return a;
    notes[a ? "failed" : "preparing"].push(name);
    return null;
  };
  const focused = new Set(focus?.on ?? []);
  const focusedLabel = (volume: Volume, label: number) =>
    volume === focusVolume && (focus?.label === undefined || focus.label === label);
  // How much of a structure shows: the panel's overall opacity times its own, 0 when hidden.
  const amount = (id: string) =>
    display.hidden.includes(id) ? 0 : display.opacity * (display.structures[id] ?? 1);
  const strong: OverlayStyle = display.style === "outline" ? "outline" : "highlight";
  const legend: LegendEntry[] = [];
  const labelColor = (label: number) => token(`--label-${((label - 1) % 12) + 1}`);
  const check = (id: string) => ({
    color: token("--check-outline"),
    opacity: amount(id),
    style: strong,
    as: "check" as const,
  });
  // What the subject itself shows, over the context: in `--output`, highlighted in slices.
  const own = (id: string) =>
    focused.has(id)
      ? check(id)
      : {
          color: token("--output"),
          opacity: amount(id),
          style: strong,
          own: true as const,
          as: "output" as const,
        };
  const contextLook = (label: number, id: string) => ({
    color: display.colours ? labelColor(label) : token("--bone"),
    opacity: amount(id) * (singled ? DIMMED_OPACITY : 1),
    style: display.style as OverlayStyle,
    as: "label" as const,
  });
  const overlays: Overlay[] = [];
  const meshes: GridMesh[] = [];
  // Meshes of the context labels: see-through once the subject has its own meshes inside them.
  const contextMeshes = new Set<GridMesh>();
  const mesh = (
    sha256: string,
    m: { path: string; vertices: number; indices: number },
    name: string,
    offsetZyx: Zyx,
    look: { color: string; opacity: number; own?: true },
    placement?: GridMesh["placement"],
  ): GridMesh => ({
    id: `${sha256}/${m.path}`,
    name,
    url: `${assetBase(sha256)}${m.path}`,
    vertices: m.vertices,
    indices: m.indices,
    offsetZyx,
    placement,
    color: look.color,
    opacity: look.opacity,
    ...(look.own && { own: true }),
  });

  // The run's segmentation is context on every output: the labels volume on this grid that the
  // most label structures point into. A run can have several (bone labels and a smaller
  // compartments volume); the one naming the most structures is the anatomy, the earliest on a tie.
  // A grid with none borrows the scan grid's, in 3D only.
  const contextOn = (grid: string | undefined) => {
    const counts = new Map<Volume, number>();
    for (const s of revision.structures) {
      const volume = s.volumeId ? volumes.get(s.volumeId) : undefined;
      if (volume?.kind === "labels" && volume.gridId === grid && s.voxels && "label" in s.voxels)
        counts.set(volume, (counts.get(volume) ?? 0) + 1);
    }
    let best: Volume | undefined;
    for (const [volume, n] of counts) if (!best || n > counts.get(best)!) best = volume;
    return best;
  };
  // Another grid's labels are placed through the two affines, only when both carry a pose. An
  // affine of the spacing alone (no rotation or origin) is what a run publishes when it lost the
  // pose, a resampled grid's included: placing through it would draw the scan's labels in the
  // wrong place, so nothing is borrowed.
  const scanContext = contextOn(scanGrid);
  const context =
    contextOn(gridId) ??
    (scanContext && posed(scanContext) && posed(image) ? scanContext : undefined);
  const placed = context && context.gridId !== gridId ? placement(context, image) : undefined;

  // Structures: a named labels volume brings every structure on it, and the context every label.
  const structureIds = new Set(named);
  for (const s of revision.structures)
    if (
      s.volumeId &&
      (s.volumeId === context?.id ||
        (named.includes(s.volumeId) && volumes.get(s.volumeId)?.kind === "labels"))
    )
      structureIds.add(s.id);
  const structures = revision.structures.filter((s) => structureIds.has(s.id) && s.voxels);
  const labelsOn = new Map<Volume, { label: number; id: string; name: string }[]>();
  if (context) labelsOn.set(context, []);
  const masks: Structure[] = [];
  for (const s of structures) {
    const volume = s.volumeId ? volumes.get(s.volumeId) : undefined;
    if (!volume || !s.voxels) continue;
    if (volume.gridId !== gridId && !(placed && volume === context && !named.includes(s.id))) {
      notes.elsewhere.push(s.name);
      continue;
    }
    if ("label" in s.voxels)
      labelsOn.set(volume, [
        ...(labelsOn.get(volume) ?? []),
        { label: s.voxels.label, id: s.id, name: s.name },
      ]);
    else masks.push(s);
  }
  let focusLabels: FocusLabels | undefined;
  // The context first, so the subject's own overlays draw over it.
  for (const [volume, labels] of labelsOn) {
    if (volume.data?.format !== "npy") {
      notes.failed.push(...labels.map((l) => l.name));
      continue;
    }
    const sha256 = volume.data.sha256;
    const a = ready(sha256, volume.name);
    if (!a) continue;
    // Another grid's context: its meshes moved onto this grid, no slice overlay.
    if (placed && volume === context) {
      for (const l of labels) {
        const look = contextLook(l.label, l.id);
        legend.push({ id: l.id, name: l.name, color: look.color, as: "label", only3d: true });
      }
      for (const m of a.meshes) {
        const l = labels.find((x) => x.label === m.label);
        if (!l) continue;
        const drawn = mesh(sha256, m, l.name, [0, 0, 0], contextLook(l.label, l.id), placed);
        contextMeshes.add(drawn);
        meshes.push(drawn);
      }
      continue;
    }
    const wanted = labels
      .filter((l) => focused.has(l.id) || focusedLabel(volume, l.label))
      .map((l) => l.label);
    // The labels a check names, else all of a labels volume it names whole.
    if ((wanted.length || focused.has(volume.id)) && !focusLabels)
      focusLabels = { source: { base: assetBase(sha256), levels: a.levels }, labels: wanted };
    // A named labels volume is the subject as a whole: every label in its own colour.
    const whole = named.includes(volume.id);
    const looks = new Map(
      labels.map((l) => [
        l.label,
        focusedLabel(volume, l.label)
          ? check(l.id)
          : !whole && (named.includes(l.id) || focused.has(l.id))
            ? own(l.id)
            : contextLook(l.label, l.id),
      ]),
    );
    for (const l of labels) {
      const look = looks.get(l.label)!;
      legend.push({
        id: l.id,
        name: l.name,
        color: look.color,
        as: look.as,
        ...(look.as !== "label" && display.colours && { usual: labelColor(l.label) }),
      });
    }
    if (looks.size)
      overlays.push({
        id: volume.id,
        name: volume.name,
        base: assetBase(sha256),
        levels: a.levels,
        offsetZyx: [0, 0, 0],
        color: Object.fromEntries([...looks].map(([label, look]) => [label, look.color])),
        opacity: Object.fromEntries([...looks].map(([label, look]) => [label, look.opacity])),
        style: Object.fromEntries([...looks].map(([label, look]) => [label, look.style])),
      });
    for (const m of a.meshes) {
      const look = m.label === undefined ? undefined : looks.get(m.label);
      const l = labels.find((x) => x.label === m.label);
      if (!look || !l) continue;
      const drawn = mesh(sha256, m, l.name, [0, 0, 0], look);
      if (look.as === "label" && !whole) contextMeshes.add(drawn);
      meshes.push(drawn);
    }
  }
  for (const s of masks) {
    if (!s.voxels || !("mask" in s.voxels)) continue;
    const { mask, offsetZyx } = s.voxels;
    const a = ready(mask.sha256, s.name);
    if (!a) continue;
    const look = own(s.id);
    legend.push({ id: s.id, name: s.name, color: look.color, as: look.as });
    overlays.push({
      id: s.id,
      name: s.name,
      base: assetBase(mask.sha256),
      levels: a.levels,
      offsetZyx,
      color: look.color,
      opacity: look.opacity,
      style: look.style,
    });
    meshes.push(...a.meshes.map((m) => mesh(mask.sha256, m, s.name, offsetZyx, look)));
  }
  // A focused labels volume no structure brings (a disagreement mask): its region in the check colour.
  if (focusVolume && focusVolume.kind === "labels" && !labelsOn.has(focusVolume)) {
    if (focusVolume.gridId !== gridId) notes.elsewhere.push(focusVolume.name);
    else if (focusVolume.data?.format !== "npy") notes.failed.push(focusVolume.name);
    else {
      const sha256 = focusVolume.data.sha256;
      const a = ready(sha256, focusVolume.name);
      if (a) {
        const values =
          focus?.label === undefined
            ? Array.from({ length: 65535 }, (_, n) => n + 1)
            : [focus.label];
        const look = check(focusVolume.id);
        legend.push({ id: focusVolume.id, name: focusVolume.name, color: look.color, as: "check" });
        overlays.push({
          id: focusVolume.id,
          name: focusVolume.name,
          base: assetBase(sha256),
          levels: a.levels,
          offsetZyx: [0, 0, 0],
          color: Object.fromEntries(values.map((v) => [v, look.color])),
          opacity: look.opacity,
          style: look.style,
        });
        focusLabels ??= {
          source: { base: assetBase(sha256), levels: a.levels },
          labels: focus?.label === undefined ? [] : [focus.label],
        };
      }
    }
  }
  // The same published surface sheet supplies 3D geometry and slice intersections.
  for (const s of revision.surfaces) {
    if (!named.includes(s.id)) continue;
    if (volumes.get(s.volumeId)?.gridId !== gridId) {
      notes.elsewhere.push(s.name);
      continue;
    }
    const look = own(s.id);
    const a = ready(s.heights.sha256, s.name);
    if (a) legend.push({ id: s.id, name: s.name, color: look.color, as: look.as });
    if (a)
      meshes.push(
        ...a.meshes.map((m) => ({
          ...mesh(s.heights.sha256, m, s.name, [0, 0, 0], look),
          trace: true,
        })),
      );
  }
  const annotations: GridAnnotation[] = [];
  for (const a of revision.annotations) {
    if (!named.includes(a.id)) continue;
    const volume = volumes.get(a.volumeId);
    if (!volume || volume.gridId !== gridId) {
      notes.elsewhere.push(a.name);
      continue;
    }
    annotations.push({
      id: a.id,
      name: a.name,
      points: (a.kind === "point" ? [a.position] : [a.a, a.b]).map(
        (p) => toVoxel(image.affine, p) as unknown as Zyx,
      ),
      color: token(focused.has(a.id) ? "--check-outline" : "--ruler"),
      opacity: 1,
    });
  }

  if (meshes.some((m) => !contextMeshes.has(m)))
    // A context mesh already carries DIMMED_OPACITY when singled; this brings it to DIMMED_CONTEXT_OPACITY.
    for (const m of contextMeshes)
      m.opacity *= singled ? DIMMED_CONTEXT_OPACITY / DIMMED_OPACITY : CONTEXT_OPACITY;

  return {
    state: "ready",
    gridId,
    imageId: image.id,
    name: image.name,
    scene: {
      shapeZyx: image.shapeZyx,
      spacingZyx: spacingZyx(image),
      measured: !unposedIdentity(image),
      image: { base: assetBase(image.data.sha256), levels: imageAssets.levels },
      imageUnit: image.unit,
      overlays,
      meshes,
      annotations,
    },
    focus: focus && focusRegion(focus, revision, image, gridId === scanGrid),
    focusLabels,
    legend,
    notes: [
      notes.preparing.length && `Still preparing: ${notes.preparing.join(", ")}.`,
      notes.failed.length && `Couldn't prepare: ${notes.failed.join(", ")}.`,
      notes.elsewhere.length && `On another grid, not shown here: ${notes.elsewhere.join(", ")}.`,
    ].filter((n): n is string => !!n),
  };
}

/**
 * The labels' bounding box, in grid voxels, from the coarsest level that has them (one or a few
 * chunks): good for framing, not for measuring. Undefined if no voxel has them.
 */
export async function labelsBox(
  { source, labels }: FocusLabels,
  signal: AbortSignal,
): Promise<VoxelBox | undefined> {
  // Downsampling can drop a thin region, so finer levels are tried up to about 32 M voxels.
  for (const level of [...source.levels].reverse()) {
    if (level.shapeZyx[0] * level.shapeZyx[1] * level.shapeZyx[2] > 2 ** 25) return;
    const box = await boxOn(source.base, level, labels, signal);
    if (box) return box;
  }
}

async function boxOn(
  base: string,
  level: ZarrSource["levels"][number],
  labels: number[],
  signal: AbortSignal,
): Promise<VoxelBox | undefined> {
  const { data, shape } = await readLevel(base, level.path, signal);
  const [nz = 0, ny = 0, nx = 0] = shape;
  const wanted = new Set(labels);
  const lo = [nz, ny, nx];
  const hi = [-1, -1, -1];
  for (let z = 0, i = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++, i++) {
        const value = data[i] as number;
        if (wanted.size ? !wanted.has(value) : !value) continue;
        const p = [z, y, x];
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a]!, p[a]!);
          hi[a] = Math.max(hi[a]!, p[a]!);
        }
      }
  if (hi[0]! < 0) return;
  // A level voxel i covers source voxels [i·s, (i+1)·s).
  const scale = level.scaleZyx;
  return {
    min: [0, 1, 2].map((a) => lo[a]! * scale[a]!) as unknown as Zyx,
    max: [0, 1, 2].map((a) => (hi[a]! + 1) * scale[a]! - 1) as unknown as Zyx,
  };
}

/** The voxel in the middle of a box: where the crosshair goes. */
export const middleOf = (box: VoxelBox): Zyx =>
  [0, 1, 2].map((a) => Math.floor((box.min[a]! + box.max[a]!) / 2)) as unknown as Zyx;

/** mm per voxel along z, y, x: the norms of the affine's x, y and z columns, reversed. */
function spacingZyx(volume: Volume): Zyx {
  const norm = (j: number) => Math.hypot(...volume.affine.slice(0, 3).map((row) => row[j]!));
  return [norm(2), norm(1), norm(0)];
}

/**
 * Where a check points on this grid and what to frame: its point or box (scan voxels, so only on
 * the scan's grid), else its cropped masks, else its annotations (world mm, through the grid's own
 * affine). A labels structure gives none: its extent isn't in the run's data (`labelsBox`).
 */
function focusRegion(
  focus: Focus,
  revision: Blocks,
  image: Volume,
  onScanGrid: boolean,
): { at: Zyx; box: VoxelBox } | undefined {
  const clamp = (p: readonly number[]) =>
    p.map((n, i) => Math.max(0, Math.min(image.shapeZyx[i]! - 1, Math.round(n)))) as unknown as Zyx;
  const around = (boxes: { min: readonly number[]; max: readonly number[] }[]) => {
    if (!boxes.length) return undefined;
    const box = {
      min: clamp([0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]!)))),
      max: clamp([0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]!)))),
    };
    return { at: middleOf(box), box };
  };
  if (onScanGrid && focus.point) {
    const at = clamp(focus.point);
    return { at, box: { min: at, max: at } };
  }
  if (onScanGrid && focus.box) return around([focus.box]);
  const sameGrid = (volumeId: string | null) =>
    revision.volumes.find((v) => v.id === volumeId)?.gridId === image.gridId;
  const masks = revision.structures.flatMap((s) => {
    const v = s.voxels;
    if (!focus.on.includes(s.id) || !sameGrid(s.volumeId) || !v || !("mask" in v)) return [];
    return [{ min: v.offsetZyx, max: v.offsetZyx.map((o, i) => o + v.mask.shapeZyx[i]! - 1) }];
  });
  if (masks.length) return around(masks);
  const marks = revision.annotations.filter((a) => focus.on.includes(a.id) && sameGrid(a.volumeId));
  const points = marks
    .flatMap((a) => (a.kind === "point" ? [a.position] : [a.a, a.b]))
    .map((world) => toVoxel(image.affine, world));
  const region = around(points.map((p) => ({ min: p, max: p })));
  // One ruler: the crosshair on its first end, since the panes' slices are thin and an end is
  // grabbed only on a slice through it.
  const [only] = marks;
  if (region && marks.length === 1 && only)
    return {
      ...region,
      at: clamp(toVoxel(image.affine, only.kind === "point" ? only.position : only.a)),
    };
  return region;
}

/**
 * A rigid move from `from`'s source voxel (x, y, z) to `to`'s, through world mm: `from`'s affine,
 * then the inverse of `to`'s. Both are spacing times a rotation, so the result is a rotation with
 * the two grids' spacing ratios and a shift; geometry moves, no voxel is resampled. Row-major 4×4.
 */
function placement(from: Volume, to: Volume): number[][] {
  const xyzOf = (world: readonly number[]) => toVoxel(to.affine, world).reverse();
  const a = from.affine;
  const origin = xyzOf([a[0]![3]!, a[1]![3]!, a[2]![3]!]);
  const columns = [0, 1, 2].map((j) =>
    xyzOf([0, 1, 2].map((r) => a[r]![j]! + a[r]![3]!)).map((n, i) => n - origin[i]!),
  );
  return [
    ...[0, 1, 2].map((i) => [columns[0]![i]!, columns[1]![i]!, columns[2]![i]!, origin[i]!]),
    [0, 0, 0, 1],
  ];
}

/** An identity affine: what a run that published no geometry for the volume gets. */
const unposedIdentity = (v: Volume) =>
  v.affine.every((row, r) => row.every((n, c) => n === (r === c ? 1 : 0)));

/** Whether a volume's affine carries a pose: an origin, or a rotation off the grid's axes. */
const posed = (v: Volume) =>
  v.affine.slice(0, 3).some((row, r) => row.some((n, c) => c !== r && n !== 0));

const unique = <T>(xs: T[]) => [...new Set(xs)];

/** The most frequent defined value, the earliest on a tie. */
function mostCommon(xs: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const x of xs) if (x) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | undefined;
  for (const [x, n] of counts) if (best === undefined || n > counts.get(best)!) best = x;
  return best;
}
