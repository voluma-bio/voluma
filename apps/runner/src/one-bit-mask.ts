/**
 * Decoder for Meta SAM's `one_bit` mask payloads (the `!` marker, which box prompts always
 * return): a base-85 text wrapper around an adaptive binary range coder with a 12-pixel
 * context. A port of the decode half of `meta-sam-parser`'s `_mask_codec`, whose pure-Python
 * and JS decoders take minutes per OA6-1RK response (1,363 masks); this takes seconds. The
 * parser's canonical-form re-encode check is dropped: the response is trusted after TLS.
 */

// Printable ASCII without the characters the wire format uses (" \ , ; < > |); the radix is 85.
const ALPHABET_VALUE = new Int8Array(128).fill(-1);
{
  let value = 0;
  for (let code = 0x21; code < 0x7f && value < 85; code++) {
    if ('"\\,;<>|'.includes(String.fromCharCode(code))) continue;
    ALPHABET_VALUE[code] = value++;
  }
}
const PREFIX = 5;
const TOP = 1 << 24;
const BOTTOM = 1 << 16;
const INCREMENT = 14;
const COUNT_LIMIT = 4096;
const PAD = 2;

// Typed arrays are read in the hot loop; a read inside the array is never undefined.
const at = (array: Uint8Array | Uint16Array, i: number) => array[i] ?? 0;

function unpack(payload: string): Uint8Array {
  const digit = (i: number) => {
    const v = ALPHABET_VALUE[payload.charCodeAt(i)] ?? -1;
    if (v < 0) throw new Error("mask payload has an invalid character");
    return v;
  };
  let length = 0;
  for (let i = 0; i < PREFIX; i++) length = length * 85 + digit(i);
  const rest = length % 4;
  if (payload.length !== PREFIX + ((length - rest) / 4) * 5 + (rest ? rest + 1 : 0)) {
    throw new Error("mask payload length does not match its prefix");
  }
  const out = new Uint8Array(length);
  let src = PREFIX;
  for (let dst = 0; dst < length - rest; dst += 4, src += 5) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + digit(src + i);
    out[dst] = v / 0x1000000;
    out[dst + 1] = v / 0x10000;
    out[dst + 2] = v / 0x100;
    out[dst + 3] = v;
  }
  if (rest) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + (i < rest + 1 ? digit(src + i) : 84);
    for (let i = 0; i < rest; i++) out[length - rest + i] = v / 2 ** (24 - 8 * i);
  }
  return out;
}

/** The mask as `height * width` bytes, 1 inside. `payload` is the text after `!`. */
export function decodeOneBit(payload: string, width: number, height: number): Uint8Array {
  const bytes = unpack(payload);
  if (bytes.length < 4) throw new Error("mask payload is truncated");
  let pos = 0;
  const next = () => {
    if (pos >= bytes.length) throw new Error("mask payload ended early");
    return at(bytes, pos++);
  };
  let low = 0;
  let range = 0xffffffff;
  let code = 0;
  for (let i = 0; i < 4; i++) code = ((code << 8) | next()) >>> 0;

  const counts = new Uint16Array(4096 * 2).fill(1);
  const pw = width + 2 * PAD;
  const padded = new Uint8Array(pw * (height + PAD));
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = (y + PAD) * pw + PAD;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      const a = p - pw; // the row above
      const b = p - 2 * pw; // two rows above
      const offset =
        (at(padded, p - 1) |
          (at(padded, p - 2) << 1) |
          (at(padded, a - 2) << 2) |
          (at(padded, a - 1) << 3) |
          (at(padded, a) << 4) |
          (at(padded, a + 1) << 5) |
          (at(padded, a + 2) << 6) |
          (at(padded, b - 2) << 7) |
          (at(padded, b - 1) << 8) |
          (at(padded, b) << 9) |
          (at(padded, b + 1) << 10) |
          (at(padded, b + 2) << 11)) <<
        1;
      const zero = at(counts, offset);
      const one = at(counts, offset + 1);
      const total = zero + one;
      const scaled = Math.floor(range / total);
      if (scaled === 0) throw new Error("mask payload has invalid coding state");
      const bit = Math.min(Math.floor(((code - low) >>> 0) / scaled), total - 1) < zero ? 0 : 1;
      low = (low + scaled * (bit ? zero : 0)) >>> 0;
      range = scaled * (bit ? one : zero);
      for (;;) {
        if ((low ^ ((low + range) >>> 0)) >>> 0 < TOP) {
          // The top byte is settled: shift it out.
        } else if (range < BOTTOM) {
          range = (-low >>> 0) & (BOTTOM - 1);
        } else break;
        code = ((code << 8) | next()) >>> 0;
        low = (low << 8) >>> 0;
        range = (range << 8) >>> 0;
      }
      padded[p] = bit;
      out[y * width + x] = bit;
      counts[offset + bit] = (bit ? one : zero) + INCREMENT;
      const n0 = at(counts, offset);
      const n1 = at(counts, offset + 1);
      if (n0 + n1 >= COUNT_LIMIT) {
        counts[offset] = n0 >> 1 || 1;
        counts[offset + 1] = n1 >> 1 || 1;
      }
    }
  }
  return out;
}
