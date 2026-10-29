/**
 * Just enough of the NumPy `.npy` format for 3D volumes: read a box of one as a windowed 8-bit
 * volume by positional reads (a scan is gigabytes; one plane of it and the 8-bit copy are
 * held), and write the header of a uint8 one.
 */
import { type FileHandle, open } from "node:fs/promises";

export type Vec3 = [number, number, number];

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

const DTYPES = {
  "|u1": { size: 1, view: (b: ArrayBuffer, n: number) => new Uint8Array(b, 0, n) },
  "<u2": { size: 2, view: (b: ArrayBuffer, n: number) => new Uint16Array(b, 0, n) },
  "<i2": { size: 2, view: (b: ArrayBuffer, n: number) => new Int16Array(b, 0, n) },
  "<i4": { size: 4, view: (b: ArrayBuffer, n: number) => new Int32Array(b, 0, n) },
  "<f4": { size: 4, view: (b: ArrayBuffer, n: number) => new Float32Array(b, 0, n) },
} as const;

export interface Npy {
  shape: Vec3;
  dtype: keyof typeof DTYPES;
  /** Byte offset of the first voxel. */
  dataStart: number;
  file: FileHandle;
}

export async function openNpy(path: string): Promise<Npy> {
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await file.read(head, 0, 12, 0);
    if (bytesRead < 12 || !MAGIC.every((b, i) => head[i] === b))
      throw new Error("not an .npy file");
    const start = head[6] === 1 ? 10 : 12;
    const end = start + (head[6] === 1 ? head.readUInt16LE(8) : head.readUInt32LE(8));
    const text = Buffer.alloc(end - start);
    await file.read(text, 0, text.length, start);
    const header = text.toString("latin1");
    const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1] ?? "";
    const dtype = (descr === "|u1" || descr === "<u1" ? "|u1" : descr) as keyof typeof DTYPES;
    if (!(dtype in DTYPES))
      throw new Error(`unsupported dtype ${descr}: use uint8, uint16, int16, int32 or float32`);
    if (/'fortran_order':\s*True/.test(header))
      throw new Error("Fortran-ordered arrays are not supported");
    const dims =
      /'shape':\s*\(([^)]*)\)/
        .exec(header)?.[1]
        ?.split(",")
        .filter((s) => s.trim())
        .map(Number) ?? [];
    if (dims.length !== 3) throw new Error(`expected a 3D array, got ${dims.length} dimensions`);
    const shape = dims as Vec3;
    const size = (await file.stat()).size;
    if (size < end + shape[0] * shape[1] * shape[2] * DTYPES[dtype].size)
      throw new Error("the .npy file is truncated");
    return { shape, dtype, dataStart: end, file };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export interface Region {
  /** The box, ends exclusive, in the volume's own indices. */
  lo: Vec3;
  hi: Vec3;
  /** 8-bit voxels of the box, z-major, with the box's own dimensions. */
  data: Uint8Array;
  /**
   * With `trim`: the box of voxels above the window's low value, ends exclusive, or undefined
   * when there are none.
   */
  above?: { lo: Vec3; hi: Vec3 };
}

/**
 * The box `[lo, hi)` as `clip((v - w0) / (w1 - w0), 0, 1) * 255`, floored. With `trim`, also the
 * extent of the voxels with `v > w0`.
 */
export async function readRegion(
  npy: Npy,
  lo: Vec3,
  hi: Vec3,
  window: [number, number],
  trim: boolean,
): Promise<Region> {
  const [w0, w1] = window;
  const { shape, dtype, dataStart, file } = npy;
  const { size, view } = DTYPES[dtype];
  const [rows, cols] = [hi[1] - lo[1], hi[2] - lo[2]];
  const planeBytes = rows * shape[2] * size;
  const buffer = new ArrayBuffer(planeBytes);
  const bytes = new Uint8Array(buffer);
  const src = view(buffer, rows * shape[2]);
  const data = new Uint8Array((hi[0] - lo[0]) * rows * cols);
  const above = { lo: [Infinity, Infinity, Infinity] as Vec3, hi: [-1, -1, -1] as Vec3 };
  let out = 0;
  for (let z = lo[0]; z < hi[0]; z++) {
    const at = dataStart + (z * shape[1] * shape[2] + lo[1] * shape[2]) * size;
    let read = 0;
    while (read < planeBytes) {
      const { bytesRead } = await file.read(bytes, read, planeBytes - read, at + read);
      if (bytesRead === 0) throw new Error("the .npy file is truncated");
      read += bytesRead;
    }
    for (let r = 0; r < rows; r++) {
      let from = r * shape[2] + lo[2];
      let first = -1;
      let last = -1;
      for (let c = 0; c < cols; c++, from++) {
        const v = src[from] as number;
        const t = (v - w0) / (w1 - w0);
        data[out++] = t <= 0 ? 0 : t >= 1 ? 255 : Math.floor(t * 255);
        if (trim && v > w0) {
          if (first < 0) first = c;
          last = c;
        }
      }
      if (first >= 0) {
        above.lo[0] = Math.min(above.lo[0], z);
        above.hi[0] = z + 1;
        above.lo[1] = Math.min(above.lo[1], lo[1] + r);
        above.hi[1] = Math.max(above.hi[1], lo[1] + r + 1);
        above.lo[2] = Math.min(above.lo[2], lo[2] + first);
        above.hi[2] = Math.max(above.hi[2], lo[2] + last + 1);
      }
    }
  }
  return { lo, hi, data, above: trim && above.hi[0] >= 0 ? above : undefined };
}

/** The header of a uint8 `.npy` of `shape`: version 1.0, padded so the data is 64-byte aligned. */
export function u8Header(shape: Vec3): Buffer {
  let header = `{'descr': '|u1', 'fortran_order': False, 'shape': (${shape.join(", ")}), }`;
  header += " ".repeat(63 - ((10 + header.length) % 64)) + "\n";
  const out = Buffer.alloc(10 + header.length);
  Buffer.from(MAGIC).copy(out);
  out[6] = 1;
  out.writeUInt16LE(header.length, 8);
  out.write(header, 10, "latin1");
  return out;
}
