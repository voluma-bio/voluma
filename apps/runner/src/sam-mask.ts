/**
 * Decoder for Meta SAM's mask payloads: `!` (`one_bit`, a base-85 text wrapper around an
 * adaptive binary range coder with a 12-pixel context) and `~` (`lossless`, a byte raster
 * coded as zero/nonzero flags plus order-two/one/zero symbol models over spatial-predictor
 * residuals, thresholded at 129). A port of the decode half of `meta-sam-parser`'s
 * `_mask_codec`, whose pure-Python and JS decoders take minutes per OA6-1RK response (1,363
 * masks); this takes seconds. The parser's canonical-form re-encode check for both encodings is
 * dropped: the response is trusted after TLS.
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
const at32 = (array: Uint32Array, i: number) => array[i] ?? 0;

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
    if (v > 0xffffffff) throw new Error("mask payload has an out-of-range group");
    out[dst] = v / 0x1000000;
    out[dst + 1] = v / 0x10000;
    out[dst + 2] = v / 0x100;
    out[dst + 3] = v;
  }
  if (rest) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + (i < rest + 1 ? digit(src + i) : 84);
    if (v > 0xffffffff) throw new Error("mask payload has an out-of-range tail");
    for (let i = 0; i < rest; i++) out[length - rest + i] = v / 2 ** (24 - 8 * i);
  }
  return out;
}

/** The mask as `height * width` bytes, 1 inside. `encoded` is a whole payload, marker first. */
export function decodeMask(encoded: string, width: number, height: number): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("mask dimensions must be positive integers");
  }
  if (!Number.isSafeInteger(width * height)) throw new Error("mask dimensions are too large");
  const marker = encoded[0];
  if (marker === "!") return decodeOneBit(encoded.slice(1), width, height);
  if (marker === "~") return decodeLossless(encoded.slice(1), width, height);
  throw new Error("the mask is neither one_bit (!) nor lossless (~)");
}

function decodeOneBit(payload: string, width: number, height: number): Uint8Array {
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

const SYMBOLS = 256;
const TOTAL = SYMBOLS; // slot after the 256 symbol counts in an order-two table
const ORDER_TWO_STEP = 14 * 44;
const ORDER_TWO_LIMIT = 14 * 3584;
const ORDER_ONE_STEP = 56;
const ORDER_ONE_LIMIT = 8192;
const ORDER_ZERO_STEP = 2 * 16;
const ORDER_ZERO_LIMIT = 2 * 2048;
const ZERO_STEP = 32;
const ZERO_LIMIT = 16384;

/** Predictor `mode` (the payload's first byte) for the byte at `offset`. */
function predict(
  output: Uint8Array,
  offset: number,
  x: number,
  y: number,
  mode: number,
  width: number,
) {
  const left = x > 0 ? at(output, offset - 1) : 0;
  const up = y > 0 ? at(output, offset - width) : 0;
  if (mode === 1) return up;
  if (mode === 2) return left;
  if (mode === 3) return (left + up) >> 1;
  const upperLeft = x > 0 && y > 0 ? at(output, offset - width - 1) : 0;
  if (mode === 0) {
    const estimate = left + up - upperLeft;
    const dl = Math.abs(estimate - left);
    const du = Math.abs(estimate - up);
    const dul = Math.abs(estimate - upperLeft);
    if (dl <= du && dl <= dul) return left;
    return du <= dul ? up : upperLeft;
  }
  if (upperLeft >= Math.max(left, up)) return Math.min(left, up);
  if (upperLeft <= Math.min(left, up)) return Math.max(left, up);
  return left + up - upperLeft;
}

function decodeLossless(payload: string, width: number, height: number): Uint8Array {
  const packed = unpack(payload);
  if (packed.length < 5) throw new Error("mask payload is truncated");
  const mode = at(packed, 0);
  if (mode >= 5) throw new Error("mask payload uses an invalid predictor");

  // Range decoder over packed[1..]; same coder as the one-bit path, with caller-given totals.
  let pos = 1;
  const next = () => {
    if (pos >= packed.length) throw new Error("mask payload ended early");
    return at(packed, pos++);
  };
  let low = 0;
  let range = 0xffffffff;
  let code = 0;
  let scaled = 0;
  for (let i = 0; i < 4; i++) code = ((code << 8) | next()) >>> 0;
  const frequency = (total: number) => {
    if (!(total > 0)) throw new Error("mask payload has invalid coding state");
    scaled = Math.floor(range / total);
    if (scaled === 0) throw new Error("mask payload has invalid coding state");
    return Math.min(Math.floor(((code - low) >>> 0) / scaled), total - 1);
  };
  const consume = (cumulative: number, freq: number) => {
    low = (low + scaled * cumulative) >>> 0;
    range = scaled * freq;
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
  };

  const length = width * height;
  const out = new Uint8Array(length); // predicted bytes, then the 0/1 answer in the end
  const residuals = new Uint8Array(length);
  const zeroCounts = new Uint32Array(32).fill(1);
  const orderOne = new Uint16Array(SYMBOLS * SYMBOLS).fill(1);
  const orderOneTotals = new Int32Array(SYMBOLS).fill(SYMBOLS);
  const orderZero = new Uint16Array(SYMBOLS).fill(2);
  let orderZeroTotal = SYMBOLS * 2;
  const orderTwo = new Map<number, Uint16Array>(); // keyed by previous residual and the one above
  let previous = 0;

  for (let offset = 0; offset < length; offset++) {
    const x = offset % width;
    const y = (offset - x) / width;
    const isZero = (i: number) => (at(residuals, i) === 0 ? 1 : 0);
    const zo =
      ((x > 0 ? isZero(offset - 1) : 1) |
        ((y > 0 ? isZero(offset - width) : 1) << 1) |
        ((x > 0 && y > 0 ? isZero(offset - width - 1) : 1) << 2) |
        ((y > 0 && x < width - 1 ? isZero(offset - width + 1) : 1) << 3)) <<
      1;
    const zero = at32(zeroCounts, zo);
    const nonzero = at32(zeroCounts, zo + 1);
    const bit = frequency(zero + nonzero) < zero ? 0 : 1;
    consume(bit ? zero : 0, bit ? nonzero : zero);
    zeroCounts[zo + bit] = at32(zeroCounts, zo + bit) + ZERO_STEP;
    if (at32(zeroCounts, zo) + at32(zeroCounts, zo + 1) >= ZERO_LIMIT) {
      zeroCounts[zo] = at32(zeroCounts, zo) >>> 1 || 1;
      zeroCounts[zo + 1] = at32(zeroCounts, zo + 1) >>> 1 || 1;
    }

    let symbol = 0;
    if (bit) {
      const above = offset >= width ? at(residuals, offset - width) : 0;
      const key = (previous << 8) | above;
      let second = orderTwo.get(key);
      if (!second) {
        second = new Uint16Array(SYMBOLS + 1);
        orderTwo.set(key, second);
      }
      const first = previous << 8;
      const excludedZero = at(second, 0) + at(orderOne, first) + at(orderZero, 0);
      const total =
        at(second, TOTAL) + (orderOneTotals[previous] ?? 0) + orderZeroTotal - excludedZero;
      const target = frequency(total);
      let cumulative = 0;
      symbol = 1;
      let freq = at(second, 1) + at(orderOne, first + 1) + at(orderZero, 1);
      while (cumulative + freq <= target) {
        cumulative += freq;
        symbol++;
        if (symbol >= SYMBOLS) throw new Error("mask payload is malformed");
        freq = at(second, symbol) + at(orderOne, first + symbol) + at(orderZero, symbol);
      }
      consume(cumulative, freq);
      // Uint16Array stores wrap at 16 bits, as the reference's explicit masks do.
      second[symbol] = at(second, symbol) + ORDER_TWO_STEP;
      second[TOTAL] = at(second, TOTAL) + ORDER_TWO_STEP;
      if (at(second, TOTAL) >= ORDER_TWO_LIMIT) {
        let sum = 0;
        for (let v = 0; v < SYMBOLS; v++) {
          second[v] = at(second, v) >> 1;
          sum += at(second, v);
        }
        second[TOTAL] = sum;
      }
      orderOne[first + symbol] = at(orderOne, first + symbol) + ORDER_ONE_STEP;
      orderOneTotals[previous] = (orderOneTotals[previous] ?? 0) + ORDER_ONE_STEP;
      if ((orderOneTotals[previous] ?? 0) >= ORDER_ONE_LIMIT) {
        let sum = 0;
        for (let v = 0; v < SYMBOLS; v++) {
          const halved = at(orderOne, first + v) >> 1 || 1;
          orderOne[first + v] = halved;
          sum += halved;
        }
        orderOneTotals[previous] = sum;
      }
      orderZero[symbol] = at(orderZero, symbol) + ORDER_ZERO_STEP;
      orderZeroTotal += ORDER_ZERO_STEP;
      if (orderZeroTotal >= ORDER_ZERO_LIMIT) {
        let sum = 0;
        for (let v = 0; v < SYMBOLS; v++) {
          orderZero[v] = at(orderZero, v) >> 1;
          sum += at(orderZero, v);
        }
        orderZeroTotal = sum;
      }
    }
    residuals[offset] = symbol;
    const delta = symbol & 1 ? -((symbol + 1) >> 1) : symbol >> 1;
    out[offset] = predict(out, offset, x, y, mode, width) + delta; // wraps to a byte
    previous = symbol;
  }
  for (let i = 0; i < length; i++) out[i] = at(out, i) >= 129 ? 1 : 0;
  return out;
}
