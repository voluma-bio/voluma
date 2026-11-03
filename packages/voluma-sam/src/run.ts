/**
 * One `voluma-sam` call, next to the data: read the volume, crop it, encode the crop, send it
 * through the gateway, receive and decode the masks, and write the labels (on the full grid)
 * and the sidecar. Files are built in a temp directory and then `cp`ed, labels first and the
 * sidecar last, because an R2 mount takes whole files only; the sidecar marks a complete result.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { encode } from "./encode";
import { type Axis, type Box, dimsOf, extentOnSlice, sliceAxes, stridesOf } from "./geometry";
import type { Crop, Prompt, SamInput, SamResult } from "./input";
import { Failure, metaClient, promptText } from "./meta";
import { openNpy, readRegion, u8Header, type Vec3 } from "./npy";
import { pasteResponse } from "./response";

/** Meta takes at most 15,000 frames. */
const MAX_FRAMES = 15_000;
/** The 8-bit volume, the labels and the file being written: about 3 bytes a voxel at peak. */
const MAX_VOXELS = 1_500_000_000;
/** Meta takes an inline image up to 50 MB; the data URL is a third larger than the PNG. */
const MAX_PNG_BYTES = 35_000_000;
/** Voxels kept around the tissue when the crop is automatic. */
const MARGIN = 8;

export async function run(
  input: SamInput,
  env: { gatewayUrl: string; token: string },
  log: (line: string) => void,
): Promise<SamResult> {
  const timings: Record<string, number> = {};
  let mark = Date.now();
  const lap = (stage: string) => {
    const now = Date.now();
    timings[stage] = now - mark;
    mark = now;
    log(`${stage}: ${timings[stage]} ms`);
  };
  const npy = await openNpy(input.volume);
  const image = npy.flat;
  if (!image && input.axis === undefined) throw new Failure("`axis` is required for a 3D volume");
  if (image && input.direction)
    throw new Failure("`direction` has no meaning for a single image: leave it out");
  // A 2D array is the slice 0 of a 1 x h x w volume, whatever `axis` the caller passed.
  const axis: Axis = image ? 0 : (input.axis as Axis);
  const outShape = image ? npy.shape.slice(1) : npy.shape;
  const [ra, ca] = sliceAxes(axis);
  const dir = await mkdtemp(join(tmpdir(), "sam-"));
  const meta = metaClient({ url: env.gatewayUrl, token: env.token, log });
  let fileId: string | undefined;
  let response: string | undefined;
  try {
    const { shape } = npy;
    const voxels = shape[0] * shape[1] * shape[2];
    if (voxels > MAX_VOXELS)
      throw new Failure(`the volume has ${voxels} voxels, over this tool's limit of ${MAX_VOXELS}`);
    const slices = shape[axis];
    const objects = (input.structures ?? []).map((s) => {
      const prompts: Prompt[] = [
        {
          frame: s.frame ?? input.keyframe ?? (image ? 0 : missingFrame(s.name)),
          box: s.box,
          points: s.points ?? [],
        },
        ...(s.otherFrames ?? []).map((o) => ({
          frame: o.frame,
          box: o.box,
          points: o.points ?? [],
        })),
      ];
      const seen = new Set<number>();
      for (const p of prompts) {
        if (seen.has(p.frame))
          throw new Failure(`"${s.name}" has two prompts on slice ${p.frame}: merge them into one`);
        seen.add(p.frame);
        if (p.frame >= slices)
          throw new Failure(`slice ${p.frame} is outside the ${slices} slices along axis ${axis}`);
        const [r0, c0, r1, c1] = p.box ?? [0, 0, 0, 0];
        if (r0 < 0 || c0 < 0 || r1 >= shape[ra] || c1 >= shape[ca] || r0 > r1 || c0 > c1)
          throw new Failure(
            `box [${p.box}] of label ${s.label} does not fit a ${shape[ra]} x ${shape[ca]} slice`,
          );
        for (const { row, col } of p.points)
          if (row < 0 || col < 0 || row >= shape[ra] || col >= shape[ca])
            throw new Failure(
              `point (row ${row}, col ${col}) of label ${s.label} does not fit a ${shape[ra]} x ${shape[ca]} slice`,
            );
      }
      return { label: s.label, name: s.name, prompts };
    });
    if (
      input.direction === "backward" &&
      Math.min(...objects.flatMap((o) => o.prompts.map((p) => p.frame))) === 0
    )
      throw new Failure(
        "`direction: backward` tracks toward slice 0 from the earliest prompted slice, so that slice cannot be 0: prompt a later slice, or use `forward` or `both`",
      );
    const full: Box = { lo: [0, 0, 0], hi: shape };

    // Read: the sub-volume alone, or everything with the extent of the tissue.
    const given = input.subVolume;
    let readBox = full;
    if (given) {
      const [z0, z1, r0, r1, c0, c1] = given;
      readBox = { lo: [z0, r0, c0], hi: [z1 + 1, r1 + 1, c1 + 1] };
      const { lo, hi } = readBox;
      if (
        !shape.every(
          (n, i) => (lo[i] ?? 0) >= 0 && (lo[i] ?? 0) < (hi[i] ?? 0) && (hi[i] ?? 0) <= n,
        )
      )
        throw new Failure(`subVolume [${given}] does not fit the volume ${shape.join(" x ")}`);
    }
    const region = await readRegion(npy, readBox.lo, readBox.hi, input.window, !given);
    lap("read");

    // Crop.
    let crop: Box;
    if (given) {
      crop = readBox;
    } else {
      if (!region.above) throw new Failure("no voxel is above the window's low value");
      const lo = region.above.lo.map((v) => Math.max(v - MARGIN, 0)) as Vec3;
      const hi = region.above.hi.map((v, i) => Math.min(v + MARGIN, shape[i] as number)) as Vec3;
      for (const { prompts } of objects) {
        for (const p of prompts) {
          const on = extentOnSlice(axis, p);
          for (let i = 0; i < 3; i++) {
            lo[i] = Math.min(lo[i] as number, on.lo[i] as number);
            hi[i] = Math.max(hi[i] as number, on.hi[i] as number);
          }
        }
      }
      crop = { lo, hi };
    }
    const cd = dimsOf(crop.lo, crop.hi);
    if (cd[axis] > MAX_FRAMES)
      throw new Failure(
        `${cd[axis]} slices along axis ${axis}; the model takes at most ${MAX_FRAMES}`,
      );
    // Frames, boxes and points in the crop's own coordinates.
    const sent = objects.map(({ label, name, prompts }) => ({
      id: label,
      prompts: prompts.map(({ frame, box, points }): Prompt => {
        if (frame < crop.lo[axis] || frame >= crop.hi[axis])
          throw new Failure(`slice ${frame} of "${name}" is outside the subVolume`);
        const inside = (row: number, col: number) =>
          row >= crop.lo[ra] && row < crop.hi[ra] && col >= crop.lo[ca] && col < crop.hi[ca];
        if (box && !(inside(box[0], box[1]) && inside(box[2], box[3])))
          throw new Failure(
            `the box of "${name}" (label ${label}) is not inside the subVolume: a clipped box would segment another shape`,
          );
        for (const { row, col } of points)
          if (!inside(row, col))
            throw new Failure(
              `the point (row ${row}, col ${col}) of "${name}" (label ${label}) is not inside the subVolume`,
            );
        return {
          frame: frame - crop.lo[axis],
          box: box && [
            box[0] - crop.lo[ra],
            box[1] - crop.lo[ca],
            box[2] - crop.lo[ra],
            box[3] - crop.lo[ca],
          ],
          points: points.map((p) => ({ ...p, row: p.row - crop.lo[ra], col: p.col - crop.lo[ca] })),
        };
      }),
    }));
    lap("crop");

    const media = join(dir, image ? "image.png" : "stack.mp4");
    const { width, height } = await encode(
      { box: readBox, data: region.data },
      crop,
      axis,
      media,
      image,
    );
    const concept = input.concept;
    const prompt = concept ? concept.phrase : promptText(sent, width, height);
    lap("encode");

    let part: Parameters<typeof meta.track>[1];
    if (image) {
      const png = await readFile(media);
      if (png.length > MAX_PNG_BYTES)
        throw new Failure(
          `the image is ${png.length} bytes as a PNG, over the ${MAX_PNG_BYTES} an inline image may be: pass a smaller subVolume`,
        );
      part = { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` };
    } else {
      // The sandbox ends a stopped call with SIGTERM, then SIGKILL 5 s later: the scan must not
      // stay in Meta's file store, so the handler stands before the upload starts and deletes
      // whatever id the upload yields.
      const uploading = meta.upload(media);
      process.once("SIGTERM", () => {
        uploading
          .then((id) => meta.remove(id, 4_000))
          .catch(() => {})
          .finally(() => process.exit(143));
      });
      fileId = await uploading;
      part = { type: "input_video", file_id: fileId };
    }
    lap("upload");
    response = join(dir, "response.sse");
    const asked = concept
      ? `concept "${concept.phrase}"`
      : objects
          .map((o) => `"${o.name}" (label ${o.label}, prompts ${JSON.stringify(o.prompts)})`)
          .join("; ");
    const direction = concept || image ? undefined : (input.direction ?? "both");
    const tracked = await meta.track(prompt, part, direction, response, asked);
    timings.wait = tracked.waitMs;
    timings.receive = tracked.receiveMs;
    mark = Date.now();
    log(`wait: ${timings.wait} ms, receive: ${timings.receive} ms`);

    // A concept prompt lets the model pick the ids: labels follow the order it first shows them.
    const first = concept?.firstLabel ?? 1;
    const instances = new Map<number, number>();
    const labelOf = (id: number): number | undefined => {
      if (!concept) return objects.some((o) => o.label === id) ? id : undefined;
      if (!instances.has(id)) {
        if (first + instances.size > 255)
          throw new Failure(
            `the model found more instances of "${concept.phrase}" than labels fit from firstLabel ${first} (labels end at 255): lower \`firstLabel\``,
          );
        instances.set(id, first + instances.size);
      }
      return instances.get(id);
    };
    const labels = new Uint8Array(cd[0] * cd[1] * cd[2]);
    const ls = stridesOf(cd);
    let pasted: Awaited<ReturnType<typeof pasteResponse>>;
    try {
      pasted = await pasteResponse(response, {
        count: cd[axis],
        height: cd[ra],
        width: cd[ca],
        paddedWidth: width,
        paddedHeight: height,
        labelOf,
        strides: [ls[axis], ls[ra], ls[ca]],
        labels,
      });
    } catch (error) {
      // Meta bills the response and this sandbox's disk is lost: keep it where a person can read it.
      const kept = `/scratch/failed-sam-response-${new Date().toISOString().replaceAll(":", "-")}.txt`;
      const copied = await copy(response, kept).then(
        () => `kept at ${kept}`,
        (e) => `not kept (${e})`,
      );
      throw new Failure(
        `${error instanceof Error ? error.message : error}; Meta's response: ${copied}`,
        error instanceof Failure && error.infrastructure,
      );
    }
    lap("decode");

    // Write: the labels on the full grid, then the sidecar, each built whole and then copied.
    const out = join(dir, basename(input.output));
    await writeFullGrid(out, labels, crop, shape, outShape);
    const sidecarPath = input.output.replace(/(\.npy)?$/, ".json");
    const requestId = tracked.requestId ?? pasted.responseId;
    // What was asked, per object: the prompts as the caller gave them (the volume's own slices
    // and pixels), or for a concept the model's id of each instance found.
    const described = concept
      ? [...instances].map(([modelId, label]) => ({
          label,
          name: `${concept.phrase} ${label - first + 1}`,
          modelId,
        }))
      : objects;
    const sidecar = {
      requestId,
      axis,
      shape: outShape,
      crop: [crop.lo[0], crop.hi[0] - 1, crop.lo[1], crop.hi[1] - 1, crop.lo[2], crop.hi[2] - 1],
      prompt,
      direction,
      objects: described.map((o) => ({
        ...o,
        // Back to the volume's own slice numbers.
        confidence: Object.fromEntries(
          Object.entries(pasted.confidence[o.label] ?? {}).map(([f, c]) => [
            Number(f) + crop.lo[axis],
            c,
          ]),
        ),
      })),
    };
    const sidecarTmp = join(dir, "sidecar.json");
    await writeFile(sidecarTmp, JSON.stringify(sidecar));
    await mkdir(dirname(input.output), { recursive: true });
    // An earlier call's sidecar must not vouch for these labels if this call is cut off.
    await rm(sidecarPath, { force: true }).catch((e) => {
      throw new Failure(`could not remove the old ${sidecarPath}: ${e}`, true);
    });
    await copy(out, input.output);
    await copy(sidecarTmp, sidecarPath);
    lap("write");

    const counts = new Uint32Array(256);
    for (const v of labels) counts[v] = (counts[v] ?? 0) + 1;
    return {
      output: input.output,
      shape: sidecar.shape,
      counts: described.map((o) => ({
        label: o.label,
        name: o.name,
        voxels: counts[o.label] ?? 0,
      })),
      sidecar: sidecarPath,
      prompt,
      frames: pasted.frames,
      requestId,
      crop: sidecar.crop as Crop,
      timings,
      stream: tracked.stream,
    };
  } finally {
    if (fileId) await meta.remove(fileId);
    await npy.file.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** The crop's labels in a volume of `shape`, plane by plane: zeros outside the crop. */
async function writeFullGrid(
  path: string,
  labels: Uint8Array,
  crop: Box,
  shape: Vec3,
  outShape: number[],
) {
  const file = await open(path, "w");
  try {
    await file.write(u8Header(outShape));
    const cd = dimsOf(crop.lo, crop.hi);
    const plane = new Uint8Array(shape[1] * shape[2]);
    for (let z = 0; z < shape[0]; z++) {
      plane.fill(0);
      if (z >= crop.lo[0] && z < crop.hi[0]) {
        for (let r = 0; r < cd[1]; r++) {
          const from = ((z - crop.lo[0]) * cd[1] + r) * cd[2];
          plane.set(labels.subarray(from, from + cd[2]), (crop.lo[1] + r) * shape[2] + crop.lo[2]);
        }
      }
      await file.write(plane);
    }
  } finally {
    await file.close();
  }
}

/** `cp`, as an R2 mount wants: one sequential write of a whole file. */
function copy(from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cp = spawn("cp", [from, to], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    cp.stderr.on("data", (d) => {
      stderr += d;
    });
    cp.once("error", (e) => reject(new Failure(`cp ${to} failed: ${e}`, true)));
    cp.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Failure(`cp ${to} failed (${code}): ${stderr.trim()}`, true)),
    );
  });
}

function missingFrame(name: string): never {
  throw new Failure(`"${name}" has no slice: give it a \`frame\` or the call a \`keyframe\``);
}
