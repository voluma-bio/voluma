/**
 * One `voluma-sam` call, next to the data: read the volume, crop it, encode the crop, send it
 * through the gateway, receive and decode the masks, and write the labels (on the full grid)
 * and the sidecar. Files are built in a temp directory and then `cp`ed, labels first and the
 * sidecar last, because an R2 mount takes whole files only; the sidecar marks a complete result.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { encode } from "./encode";
import { type Box, boxOnSlice, dimsOf, sliceAxes, stridesOf } from "./geometry";
import type { Crop, SamInput, SamResult } from "./input";
import { Failure, metaClient, promptText } from "./meta";
import { openNpy, readRegion, u8Header, type Vec3 } from "./npy";
import { pasteResponse } from "./response";

/** Meta takes at most 15,000 frames. */
const MAX_FRAMES = 15_000;
/** The 8-bit volume, the labels and the file being written: about 3 bytes a voxel at peak. */
const MAX_VOXELS = 1_500_000_000;
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
  const { axis, structures } = input;
  const [ra, ca] = sliceAxes(axis);
  const npy = await openNpy(input.volume);
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
    const objects = structures.map(({ label, name, box, frame }) => {
      const f = frame ?? input.keyframe;
      const [r0, c0, r1, c1] = box;
      if (f >= slices)
        throw new Failure(`slice ${f} is outside the ${slices} slices along axis ${axis}`);
      if (r0 < 0 || c0 < 0 || r1 >= shape[ra] || c1 >= shape[ca] || r0 > r1 || c0 > c1) {
        throw new Failure(
          `box [${box}] of label ${label} does not fit a ${shape[ra]} x ${shape[ca]} slice`,
        );
      }
      return { label, name, frame: f, box, on: boxOnSlice(axis, f, box) };
    });
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
      for (const { on } of objects) {
        for (let i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i] as number, on.lo[i] as number);
          hi[i] = Math.max(hi[i] as number, on.hi[i] as number);
        }
      }
      crop = { lo, hi };
    }
    const cd = dimsOf(crop.lo, crop.hi);
    if (cd[axis] > MAX_FRAMES)
      throw new Failure(
        `${cd[axis]} slices along axis ${axis}; the model takes at most ${MAX_FRAMES}`,
      );
    // Boxes and frames in the crop's own coordinates.
    const sent = objects.map(({ label, name, frame, box }) => {
      if (frame < crop.lo[axis] || frame >= crop.hi[axis])
        throw new Failure(`slice ${frame} of "${name}" is outside the subVolume`);
      if (
        box[0] < crop.lo[ra] ||
        box[2] >= crop.hi[ra] ||
        box[1] < crop.lo[ca] ||
        box[3] >= crop.hi[ca]
      )
        throw new Failure(
          `the box of "${name}" (label ${label}) is not inside the subVolume: a clipped box would segment another shape`,
        );
      return {
        label,
        name,
        frame: frame - crop.lo[axis],
        box: [
          box[0] - crop.lo[ra],
          box[1] - crop.lo[ca],
          box[2] - crop.lo[ra],
          box[3] - crop.lo[ca],
        ] as [number, number, number, number],
      };
    });
    lap("crop");

    const video = join(dir, "stack.mp4");
    const { width, height } = await encode({ box: readBox, data: region.data }, crop, axis, video);
    const prompt = promptText(sent, width, height);
    lap("encode");

    // The sandbox ends a stopped call with SIGTERM, then SIGKILL 5 s later: the scan must not
    // stay in Meta's file store, so the handler stands before the upload starts and deletes
    // whatever id the upload yields.
    const uploading = meta.upload(video);
    process.once("SIGTERM", () => {
      uploading
        .then((id) => meta.remove(id, 4_000))
        .catch(() => {})
        .finally(() => process.exit(143));
    });

    fileId = await uploading;
    lap("upload");
    response = join(dir, "response.sse");
    const asked = sent
      .map((o) => `"${o.name}" (label ${o.label}, frame ${o.frame}, box [${o.box}])`)
      .join("; ");
    const tracked = await meta.track(prompt, fileId, response, asked);
    timings.wait = tracked.waitMs;
    timings.receive = tracked.receiveMs;
    mark = Date.now();
    log(`wait: ${timings.wait} ms, receive: ${timings.receive} ms`);

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
        known: new Set(sent.map((o) => o.label)),
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
    await writeFullGrid(out, labels, crop, shape);
    const sidecarPath = input.output.replace(/(\.npy)?$/, ".json");
    const requestId = tracked.requestId ?? pasted.responseId;
    const sidecar = {
      requestId,
      axis,
      shape,
      crop: [crop.lo[0], crop.hi[0] - 1, crop.lo[1], crop.hi[1] - 1, crop.lo[2], crop.hi[2] - 1],
      prompt,
      objects: structures.map(({ label, name, box, frame }) => ({
        label,
        name,
        promptFrame: frame ?? input.keyframe,
        box,
        // Back to the volume's own slice numbers.
        confidence: Object.fromEntries(
          Object.entries(pasted.confidence[label] ?? {}).map(([f, c]) => [
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
      shape,
      counts: structures.map((s) => ({
        label: s.label,
        name: s.name,
        voxels: counts[s.label] ?? 0,
      })),
      sidecar: sidecarPath,
      prompt,
      frames: pasted.frames,
      requestId,
      crop: sidecar.crop as Crop,
      timings,
    };
  } finally {
    if (fileId) await meta.remove(fileId);
    await npy.file.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** The crop's labels in a volume of `shape`, plane by plane: zeros outside the crop. */
async function writeFullGrid(path: string, labels: Uint8Array, crop: Box, shape: Vec3) {
  const file = await open(path, "w");
  try {
    await file.write(u8Header(shape));
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
