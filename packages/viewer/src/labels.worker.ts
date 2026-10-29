/** Bounded, integrity-checked NPY label loading and voxel bounds off the UI thread. */
import type { Point3 } from "./dicom";
import type { LabelSource, LabelVolume } from "./labels";

self.onmessage = async ({ data: source }: MessageEvent<LabelSource>) => {
  try {
    const { volume } = source;
    const data = volume.data;
    if (volume.kind !== "labels" || data?.format !== "npy")
      throw new Error("Not an NPY labels volume.");
    const width = data.dtype === "uint8" ? 1 : data.dtype === "uint16" ? 2 : 0;
    const count = volume.shapeZyx.reduce((a, b) => a * b, 1);
    const payload = count * width;
    if (!width || !Number.isSafeInteger(payload) || payload > 512 * 1024 ** 2)
      throw new Error("Label volume exceeds the 512 MiB limit.");
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`Could not load labels (${response.status}).`);
    const length = Number(response.headers.get("Content-Length"));
    if (
      !Number.isSafeInteger(length) ||
      length < payload + 10 ||
      length > payload + 65536 ||
      response.headers.get("Content-Encoding")
    )
      throw new Error("Invalid label transfer size or encoding.");
    const buffer = new ArrayBuffer(length);
    const bytes = new Uint8Array(buffer);
    const reader = response.body!.getReader();
    let offset = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.length > length)
          throw new Error("Label transfer exceeds its declared size.");
        bytes.set(value, offset);
        offset += value.length;
      }
    } finally {
      await reader.cancel();
    }
    if (offset !== length) throw new Error("Incomplete label transfer.");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== data.sha256) throw new Error("Label file hash does not match its evidence.");
    if (
      bytes[0] !== 147 ||
      new TextDecoder().decode(bytes.subarray(1, 6)) !== "NUMPY" ||
      ![1, 2, 3].includes(bytes[6]!)
    )
      throw new Error("Unsupported NPY header.");
    const view = new DataView(buffer);
    const start = bytes[6] === 1 ? 10 : 12;
    const headerLength = start === 10 ? view.getUint16(8, true) : view.getUint32(8, true);
    const header = new TextDecoder().decode(bytes.subarray(start, start + headerLength));
    const dtype = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(header)?.[1];
    const shape = /['"]shape['"]\s*:\s*\(([^)]+)\)/
      .exec(header)?.[1]
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    if (
      dtype !== (width === 1 ? "|u1" : "<u2") ||
      !/['"]fortran_order['"]\s*:\s*False/.test(header) ||
      shape?.join() !== volume.shapeZyx.join()
    )
      throw new Error("NPY dtype, order or shape differs from the declared labels.");
    const begin = start + headerLength;
    if (begin % width || begin + payload !== length)
      throw new Error("Invalid NPY payload length or alignment.");
    const values =
      width === 1 ? new Uint8Array(buffer, begin, count) : new Uint16Array(buffer, begin, count);
    const bounds: LabelVolume["bounds"] = {};
    const [, rows, columns] = volume.shapeZyx;
    for (let z = 0, i = 0; z < volume.shapeZyx[0]; z++)
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < columns; x++, i++) {
          const label = values[i]!;
          if (!label) continue;
          const b = bounds[label];
          if (!b) bounds[label] = { min: [z, y, x], max: [z, y, x], point: [z, y, x] };
          else {
            const p: Point3 = [z, y, x];
            for (let a = 0; a < 3; a++) {
              b.min[a] = Math.min(b.min[a]!, p[a]!);
              b.max[a] = Math.max(b.max[a]!, p[a]!);
            }
          }
        }
    self.postMessage({ layer: { ...source, values, bounds } }, { transfer: [buffer] });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "Labels could not be loaded.",
    });
  }
};
