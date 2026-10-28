/**
 * Just enough of the NumPy `.npy` format for 3D volumes: read one as a windowed 8-bit stack
 * from a stream (a scan is gigabytes; only the 8-bit copy is held), and write a uint8 one.
 */

export type Shape3 = [number, number, number];

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

const DTYPES = {
  "|u1": { size: 1, read: (v: DataView, o: number) => v.getUint8(o) },
  "<u2": { size: 2, read: (v: DataView, o: number) => v.getUint16(o, true) },
  "<i2": { size: 2, read: (v: DataView, o: number) => v.getInt16(o, true) },
  "<i4": { size: 4, read: (v: DataView, o: number) => v.getInt32(o, true) },
  "<f4": { size: 4, read: (v: DataView, o: number) => v.getFloat32(o, true) },
} as const;

/** Where the header ends, from the first 12 bytes. */
function headerEnd(bytes: Uint8Array): number {
  if (!MAGIC.every((b, i) => bytes[i] === b)) throw new Error("not an .npy file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytes[6] === 1 ? 10 + view.getUint16(8, true) : 12 + view.getUint32(8, true);
}

function parseHeader(bytes: Uint8Array): {
  dtype: keyof typeof DTYPES;
  shape: Shape3;
  end: number;
} {
  const end = headerEnd(bytes);
  const start = bytes[6] === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(start, end));
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
  return { dtype, shape: dims as Shape3, end };
}

/** The volume as `clip((v - lo) / (hi - lo), 0, 1) * 255`, floored, in file order. */
export async function readWindowed(
  chunks: AsyncIterable<Uint8Array>,
  window: [number, number],
): Promise<{ shape: Shape3; data: Uint8Array }> {
  const [lo, hi] = window;
  let header: ReturnType<typeof parseHeader> | undefined;
  let data = new Uint8Array(0);
  let filled = 0;
  let carry: Uint8Array = new Uint8Array(0);
  for await (const chunk of chunks) {
    let bytes: Uint8Array = chunk;
    if (!header) {
      carry = concat(carry, bytes);
      if (carry.length < 12 || carry.length < headerEnd(carry)) continue;
      header = parseHeader(carry);
      data = new Uint8Array(header.shape[0] * header.shape[1] * header.shape[2]);
      bytes = carry.subarray(header.end);
      carry = new Uint8Array(0);
    }
    const { size, read } = DTYPES[header.dtype];
    bytes = concat(carry, bytes);
    const whole = bytes.length - (bytes.length % size);
    const view = new DataView(bytes.buffer, bytes.byteOffset, whole);
    for (let o = 0; o < whole && filled < data.length; o += size) {
      const t = (read(view, o) - lo) / (hi - lo);
      data[filled++] = t <= 0 ? 0 : t >= 1 ? 255 : Math.floor(t * 255);
    }
    carry = bytes.slice(whole);
  }
  if (!header || filled !== data.length) throw new Error("the .npy file is truncated");
  return { shape: header.shape, data };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** A uint8 `.npy` of `shape`. */
export function writeU8(data: Uint8Array, shape: Shape3): Uint8Array {
  let header = `{'descr': '|u1', 'fortran_order': False, 'shape': (${shape.join(", ")}), }`;
  // Version 1.0: magic, version, 2-byte length, then the header padded so the data is 64-byte aligned.
  header += " ".repeat(63 - ((10 + header.length) % 64)) + "\n";
  const out = new Uint8Array(new ArrayBuffer(10 + header.length + data.length));
  out.set(MAGIC);
  out[6] = 1;
  new DataView(out.buffer).setUint16(8, header.length, true);
  out.set(new TextEncoder().encode(header), 10);
  out.set(data, 10 + header.length);
  return out;
}
