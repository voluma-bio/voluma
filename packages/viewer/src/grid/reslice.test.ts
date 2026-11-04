/**
 * Where a tilted pane's samples land in a level's chunks: half a voxel off, or a crop offset or
 * level scale applied twice, shifts every resliced picture and its labels, and nothing on screen
 * says so.
 */
import { describe, expect, it } from "vitest";
import { gridBasis } from "./frame";
import { type ChunkGrid, crossed, onLevel, sample, sampling } from "./reslice";
import type { Zyx } from "./scene";

/** A level whose voxel (k, j, i) holds 10000k + 100j + i, cut into chunks of `size` (edges padded). */
function level(shape: Zyx, size: Zyx): ChunkGrid {
  const grid = shape.map((n, k) => Math.ceil(n / size[k]!));
  const chunks: ChunkGrid["chunks"][number][] = [];
  for (let ck = 0; ck < grid[0]!; ck++)
    for (let cj = 0; cj < grid[1]!; cj++)
      for (let ci = 0; ci < grid[2]!; ci++) {
        const data = new Float32Array(size[0] * size[1] * size[2]);
        for (let k = 0; k < size[0]; k++)
          for (let j = 0; j < size[1]; j++)
            for (let i = 0; i < size[2]; i++)
              data[(k * size[1] + j) * size[2] + i] =
                10000 * (ck * size[0] + k) + 100 * (cj * size[1] + j) + ci * size[2] + i;
        chunks.push({ data, stride: [size[1] * size[2], size[2], 1] });
      }
  return { shape, size, chunks };
}

const spacing: Zyx = [0.02, 0.01, 0.01];
const shape: Zyx = [8, 9, 10];

describe("reslice", () => {
  it("lands on the voxel centres of the slice it holds, at every level", () => {
    // Level 1 of an 8×9×10 grid; the pane holds z, its plane through source z = 4.5,
    // the centre of level-1 voxel 2.
    const l1 = level([4, 5, 5], [3, 2, 4]);
    const at = sampling(gridBasis(0), [4.5, 0, 0], spacing, shape, 2 * 0.01);
    const on = onLevel(at, gridBasis(0), spacing, [2, 2, 2], [0, 0, 0]);
    expect([on.rows, on.cols]).toEqual([5, 5]);
    expect(Array.from(sample(on, l1, false))).toEqual(
      Array.from({ length: 25 }, (_, i) => 20000 + 100 * Math.floor(i / 5) + (i % 5)),
    );
  });

  it("puts a cropped overlay's voxel under the image pixel that holds it", () => {
    // A crop at source (2, 3, 1); the plane at source z = 3 is crop z = 1.
    const crop = level([4, 3, 2], [4, 3, 2]);
    const at = sampling(gridBasis(0), [3, 0, 0], spacing, shape, 0.01);
    const on = onLevel(at, gridBasis(0), spacing, [1, 1, 1], [2, 3, 1]);
    const values = sample(on, crop, true);
    expect(crossed(on, crop.shape, crop.size)).toEqual([0]);
    const at3 = (y: number, x: number) => values[y * on.cols + x];
    expect(at3(3, 1)).toBe(10000);
    expect(at3(5, 2)).toBe(10201);
    expect(at3(2, 1)).toBe(0);
    expect(at3(3, 3)).toBe(0);
  });
});
