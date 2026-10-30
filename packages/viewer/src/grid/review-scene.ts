/**
 * A task's view in the grid viewer, from the run's review data: which grid to show, and the
 * image, label overlays, masks and surfaces on it, from `ReviewRun.assets`. A check's `focus`
 * picks the grid, is outlined in `--check-outline`, and places the crosshair.
 *
 * The blocks shown are the check's `focus.on`, plus every block the task's measurements and
 * scores are shown with (`on`, `context`); a task that names none shows the blocks it produced
 * (ids under `<taskId>/`). The grid is the first focus block's volume, else the volume most of
 * those blocks sit on, else the scan. Blocks on another grid are left out: the viewer never
 * resamples. A block whose file has no converted assets yet is "preparing", one whose conversion
 * failed "failed"; neither is drawn.
 */
import type { ReviewRun, ReviewTask, Revision, Volume } from "@voluma/contracts/review";
import { readLevel } from "./planes";
import type { GridMesh, GridScene, Overlay, Zyx } from "./scene";
import { spacingOf } from "./scene";

/** One block the view is about, and whether it is drawn. */
export type SceneObject = {
  id: string;
  name: string;
  /** `unsupported`: a kind the grid viewer doesn't draw yet (rulers and landmarks). */
  state: "ready" | "preparing" | "failed" | "unsupported";
  /** The conversion's error, for `failed`. */
  error?: string;
  /** Named by the check's focus: outlined in amber. */
  underCheck: boolean;
};

export type TaskScene =
  | {
      state: "ready";
      /** The shown image's volume block id (`${taskId}/${outputId}`): what a mark names. */
      imageId: string;
      scene: GridScene;
      /** Where the crosshair starts, when the review data says. */
      point: Zyx;
      /**
       * Set when the region under check is labels with no point in the review data: finds their
       * centre on the coarsest level (one or a few chunks). Wait for it before the viewer mounts.
       */
      locate?: (signal: AbortSignal) => Promise<Zyx | undefined>;
      objects: SceneObject[];
    }
  /** The grid's image itself isn't drawable: no view, only why. */
  | { state: "preparing" | "failed" | "none"; error?: string; objects: SceneObject[] };

type Assets = ReviewRun["assets"];
type Ready = Extract<Assets[string], { state: "ready" }>;

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * `assetBase(sha256)`: the absolute URL prefix, ending in "/", of a file's converted assets
 * (the review assets route). `checkId` absent: the whole task, no outline.
 */
export function taskScene(
  run: ReviewRun,
  taskId: string,
  checkId: string | undefined,
  assetBase: (sha256: string) => string,
): TaskScene {
  const rev = run.revisions.at(-1)!;
  const task = rev.tasks.find((t) => t.id === taskId);
  const focus = task?.checks.find((c) => c.id === checkId)?.focus;
  const under = new Set([...(focus?.on ?? []), ...(focus?.volumeId ? [focus.volumeId] : [])]);
  const ids = [...new Set([...under, ...(task ? taskBlocks(task, rev) : [])])];

  const volumes = new Map(rev.volumes.map((v) => [v.id, v]));
  const blockVolume = (id: string): Volume | undefined => {
    if (volumes.has(id)) return volumes.get(id);
    const block =
      rev.structures.find((b) => b.id === id) ??
      rev.surfaces.find((b) => b.id === id) ??
      rev.annotations.find((b) => b.id === id);
    return block?.volumeId ? volumes.get(block.volumeId) : undefined;
  };
  const grid = pickGrid(ids, under, blockVolume, rev);
  const objects: SceneObject[] = [];
  const object = (id: string, name: string, state: SceneObject["state"], error?: string) =>
    objects.push({ id, name, state, error, underCheck: under.has(id) });
  const image = grid && imageOf(grid.gridId, rev);
  const imageAssets = image?.data?.format === "npy" ? run.assets[image.data.sha256] : undefined;
  if (!image || image.data?.format !== "npy") return { state: "none", objects };
  if (!imageAssets) return { state: "preparing", objects };
  if (imageAssets.state === "failed") return { state: "failed", error: imageAssets.error, objects };

  const overlays: Overlay[] = [];
  const meshes: GridMesh[] = [];
  const outline = token("--check-outline");
  let colour = 0;
  const nextColour = () => token(`--label-${(colour++ % 12) + 1}`);
  const mesh =
    (sha256: string, offsetZyx: Zyx, color: string, opacity: number) =>
    (m: Ready["meshes"][number]): GridMesh => ({
      id: `${sha256}/${m.path}`,
      name: m.label ? `label ${m.label}` : sha256.slice(0, 8),
      url: `${assetBase(sha256)}${m.path}`,
      vertices: m.vertices,
      indices: m.indices,
      offsetZyx,
      color,
      opacity,
    });
  /** The file's converted assets, after recording the block in `objects`; undefined when not drawable. */
  const ready = (id: string, name: string, sha256: string | undefined): Ready | undefined => {
    const a = sha256 ? run.assets[sha256] : undefined;
    object(id, name, !a ? "preparing" : a.state, a?.state === "failed" ? a.error : undefined);
    return a?.state === "ready" ? a : undefined;
  };
  const npy = (v: Volume | undefined) => (v?.data?.format === "npy" ? v.data.sha256 : undefined);

  // Labels on the grid's labels volumes, by volume: every label when the volume itself is named.
  type Labels = Set<number> | "all";
  const labels = new Map<string, { volume: Volume; shown: Labels; under: Labels }>();
  const add = (set: Labels, value: number | "all"): Labels =>
    set === "all" || value === "all" ? "all" : set.add(value);
  const addLabels = (volume: Volume, value: number | "all", isUnder: boolean) => {
    const entry = labels.get(volume.id) ?? { volume, shown: new Set(), under: new Set() };
    entry.shown = add(entry.shown, value);
    if (isUnder) entry.under = add(entry.under, value);
    labels.set(volume.id, entry);
  };
  if (focus?.volumeId && focus.label !== undefined) {
    const v = volumes.get(focus.volumeId);
    if (v?.gridId === grid.gridId) addLabels(v, focus.label, true);
  }

  for (const id of ids) {
    if (blockVolume(id)?.gridId !== grid.gridId) continue;
    const isUnder = under.has(id);
    const volume = volumes.get(id);
    if (volume) {
      if (volume.kind === "labels") addLabels(volume, "all", isUnder);
      continue;
    }
    const structure = rev.structures.find((s) => s.id === id);
    if (structure?.voxels && "label" in structure.voxels) {
      const volume = volumes.get(structure.volumeId!)!;
      addLabels(volume, structure.voxels.label, isUnder);
      ready(id, structure.name, npy(volume));
      continue;
    }
    if (structure?.voxels && "mask" in structure.voxels) {
      const { mask, offsetZyx } = structure.voxels;
      const a = ready(id, structure.name, mask.sha256);
      if (!a) continue;
      const color = isUnder ? outline : nextColour();
      overlays.push({
        id,
        name: structure.name,
        base: assetBase(mask.sha256),
        levels: a.levels,
        offsetZyx,
        color,
        outline: isUnder,
      });
      meshes.push(...a.meshes.map(mesh(mask.sha256, offsetZyx, color, 1)));
      continue;
    }
    const surface = rev.surfaces.find((s) => s.id === id);
    if (surface) {
      const a = ready(id, surface.name, surface.heights.sha256);
      if (a)
        meshes.push(
          ...a.meshes.map(
            mesh(surface.heights.sha256, [0, 0, 0], isUnder ? outline : nextColour(), 1),
          ),
        );
      continue;
    }
    const annotation = rev.annotations.find((a) => a.id === id);
    if (annotation) object(id, annotation.name, "unsupported");
  }

  for (const { volume, shown, under: underLabels } of labels.values()) {
    const sha256 = npy(volume);
    const a = sha256 ? run.assets[sha256] : undefined;
    // A labels volume named as a whole is one object; named structures were recorded one by one.
    if (shown === "all") ready(volume.id, volume.name, sha256);
    if (!sha256 || a?.state !== "ready") continue;
    const has = (set: Labels, label: number) => set === "all" || set.has(label);
    const all = Array.from({ length: 255 }, (_, n) => n + 1);
    const fill = all.filter((n) => has(shown, n) && !has(underLabels, n));
    const edge = all.filter((n) => has(underLabels, n));
    const layer = (values: number[], isUnder: boolean): Overlay => ({
      id: `${volume.id}${isUnder ? "#under" : ""}`,
      name: volume.name,
      base: assetBase(sha256),
      levels: a.levels,
      offsetZyx: [0, 0, 0],
      color: Object.fromEntries(
        values.map((n) => [n, isUnder ? outline : token(`--label-${((n - 1) % 12) + 1}`)]),
      ),
      outline: isUnder,
    });
    if (fill.length) overlays.push(layer(fill, false));
    if (edge.length) overlays.push(layer(edge, true));
    // Bones as see-through ivory shells, so what lies inside them shows; the one under check amber.
    for (const m of a.meshes) {
      if (m.label === undefined || !has(shown, m.label)) continue;
      const isUnder = has(underLabels, m.label);
      meshes.push(
        mesh(sha256, [0, 0, 0], isUnder ? outline : token("--bone"), isUnder ? 1 : 0.35)(m),
      );
    }
  }

  const shapeZyx = imageAssets.levels[0]?.shapeZyx ?? image.shapeZyx;
  const scene: GridScene = {
    shapeZyx,
    spacingZyx: spacingOf(image.affine),
    image: { base: assetBase(image.data.sha256), levels: imageAssets.levels, offsetZyx: [0, 0, 0] },
    // Outlines last, so they draw over the fills.
    overlays: overlays.sort((a, b) => Number(!!a.outline) - Number(!!b.outline)),
    meshes,
  };
  const located = focusPoint(focus, [...under], rev, image, shapeZyx);
  const labelled = overlays.find((o) => o.outline && typeof o.color !== "string");
  return {
    state: "ready",
    imageId: image.id,
    scene,
    point: located ?? (shapeZyx.map((n) => Math.floor(n / 2)) as unknown as Zyx),
    locate:
      !located && labelled
        ? (signal) => centreOf(labelled, Object.keys(labelled.color).map(Number), signal)
        : undefined,
    objects,
  };
}

/** The blocks a task is shown with: its values' `on` and `context`, else the blocks it made. */
function taskBlocks(task: ReviewTask, rev: Revision): string[] {
  const named = [...task.measurements, ...task.scores].flatMap((m) => [...m.on, ...m.context]);
  if (named.length) return named;
  const own = `${task.id}/`;
  return [...rev.volumes, ...rev.structures, ...rev.surfaces, ...rev.annotations]
    .map((b) => b.id)
    .filter((id) => id.startsWith(own));
}

function pickGrid(
  ids: string[],
  under: Set<string>,
  blockVolume: (id: string) => Volume | undefined,
  rev: Revision,
): Volume | undefined {
  const first = [...under].map(blockVolume).find(Boolean);
  if (first) return first;
  const count = new Map<string, { volume: Volume; n: number }>();
  for (const id of ids) {
    const v = blockVolume(id);
    if (!v) continue;
    const entry = count.get(v.gridId) ?? { volume: v, n: 0 };
    entry.n++;
    count.set(v.gridId, entry);
  }
  const most = [...count.values()].sort((a, b) => b.n - a.n)[0]?.volume;
  return most ?? rev.volumes.find((v) => v.kind === "image");
}

/** The grid's image: an `image` volume on it, one with loadable data first. */
function imageOf(gridId: string, rev: Revision): Volume | undefined {
  const images = rev.volumes.filter((v) => v.gridId === gridId && v.kind === "image");
  return images.find((v) => v.data?.format === "npy") ?? images[0];
}

/**
 * Where the crosshair starts: the focus point, the centre of its box, of its first cropped mask,
 * or of its first ruler or landmark; undefined when the review data doesn't say.
 */
function focusPoint(
  focus: ReviewTask["checks"][number]["focus"],
  under: string[],
  rev: Revision,
  image: Volume,
  shapeZyx: Zyx,
): Zyx | undefined {
  const clamp = (p: readonly number[]): Zyx =>
    p.map((v, i) => Math.max(0, Math.min(shapeZyx[i]! - 1, Math.round(v)))) as unknown as Zyx;
  if (focus?.point) return clamp(focus.point);
  if (focus?.box) return clamp(focus.box.min.map((lo, i) => (lo + focus.box!.max[i]!) / 2));
  for (const id of under) {
    const s = rev.structures.find((b) => b.id === id);
    if (s?.voxels && "mask" in s.voxels) {
      const { mask, offsetZyx } = s.voxels;
      return clamp(offsetZyx.map((o, i) => o + mask.shapeZyx[i]! / 2));
    }
    const a = rev.annotations.find((b) => b.id === id);
    if (a) {
      const world = a.kind === "point" ? a.position : a.a.map((v, i) => (v + a.b[i]!) / 2);
      return clamp(voxelOf(image.affine, world));
    }
  }
  return undefined;
}

/** The centre of the voxels holding `labels`, from the overlay's coarsest level, in grid voxels. */
async function centreOf(overlay: Overlay, labels: number[], signal: AbortSignal) {
  const level = overlay.levels.at(-1);
  if (!level) return undefined;
  const { data, shape } = await readLevel(overlay.base, level.path, signal);
  const wanted = new Set(labels);
  const [, ny, nx] = shape as [number, number, number];
  const sum: [number, number, number] = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    if (!wanted.has(data[i]!)) continue;
    sum[0] += Math.floor(i / (ny * nx));
    sum[1] += Math.floor(i / nx) % ny;
    sum[2] += i % nx;
    n++;
  }
  if (!n) return undefined;
  // Level voxel j spans source voxels [j·s, (j+1)·s): its centre is j·s + (s − 1)/2.
  return sum.map(
    (total, i) =>
      Math.round((total / n) * level.scaleZyx[i]! + (level.scaleZyx[i]! - 1) / 2) +
      overlay.offsetZyx[i]!,
  ) as unknown as Zyx;
}

/** World mm to voxel (z, y, x) through an affine with orthogonal columns (`volumeSchema`). */
function voxelOf(affine: Volume["affine"], world: readonly number[]): number[] {
  const d = [0, 1, 2].map((r) => world[r]! - affine[r]![3]!);
  // Column j of the 3x3 part is voxel axis j (x, y, z) in mm; projecting on it inverts it.
  const along = (j: number) => {
    const c = [affine[0]![j]!, affine[1]![j]!, affine[2]![j]!];
    return (c[0]! * d[0]! + c[1]! * d[1]! + c[2]! * d[2]!) / (c[0]! ** 2 + c[1]! ** 2 + c[2]! ** 2);
  };
  return [along(2), along(1), along(0)];
}
