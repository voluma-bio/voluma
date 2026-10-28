/**
 * The Segmenter port: a promptable segmentation model behind `segment_sam`. It takes a
 * stack of 8-bit slices and box prompts and returns one label per voxel. Adapter today:
 * Meta's Model API (`apps/runner/src/meta-segmenter.ts`); a self-hosted open-weights model is
 * the plausible second, for scans that may not leave our cloud.
 */

/** `count` slices of `height` rows by `width` columns, slice-major, row-major, one byte per voxel. */
export interface SliceStack {
  data: Uint8Array;
  count: number;
  height: number;
  width: number;
}

export interface SegmentObject {
  /** 1 to 255, the value its voxels carry in the result. */
  label: number;
  /** The slice the box is drawn on. */
  frame: number;
  /** Pixels of that slice, ends inclusive: `[row0, col0, row1, col1]`. */
  box: [number, number, number, number];
}

export interface SegmentResult {
  /** A stack of the input's shape; 0 is no object, and no voxel has two labels. */
  labels: Uint8Array;
  /** The prompt text the model was sent, for the record. */
  prompt: string;
  /** What the provider billed, for the run's cost. */
  costUsd: number;
}

export interface Segmenter {
  /** Tracks every object through the whole stack, both directions from its box. */
  segment(stack: SliceStack, objects: SegmentObject[], signal: AbortSignal): Promise<SegmentResult>;
}
