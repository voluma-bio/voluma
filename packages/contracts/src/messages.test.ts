import { describe, expect, it } from "vitest";
import { markSchema } from "./messages";

const volumeId = "t1/vol";
const line = { aZyx: [1, 2, 3], bZyx: [1.5, 2, 9], lengthMm: 0.4 };
const outline = {
  axis: 0,
  zyx: [
    [5, 1, 1],
    [5, 1, 9],
    [5, 7, 4],
  ],
  areaMm2: 1.2,
};

describe("markSchema", () => {
  it("accepts each kind alone", () => {
    for (const k of [
      { point: [1, 2, 3] },
      { box: { min: [0, 0, 0], max: [1, 1, 1] } },
      { line },
      { outline },
    ]) {
      expect(markSchema.safeParse({ volumeId, ...k }).success).toBe(true);
    }
  });

  it("needs exactly one kind", () => {
    expect(markSchema.safeParse({ volumeId }).success).toBe(false);
    expect(markSchema.safeParse({ volumeId, point: [1, 2, 3], line }).success).toBe(false);
    expect(markSchema.safeParse({ volumeId, line, outline }).success).toBe(false);
  });

  it("rejects an outline off one slice, or with too few or too many points", () => {
    const bad = (o: object) =>
      markSchema.safeParse({ volumeId, outline: { ...outline, ...o } }).success;
    expect(
      bad({
        zyx: [
          [5, 1, 1],
          [6, 1, 9],
          [5, 7, 4],
        ],
      }),
    ).toBe(false);
    expect(bad({ axis: 2 })).toBe(false);
    expect(bad({ zyx: outline.zyx.slice(0, 2) })).toBe(false);
    expect(bad({ zyx: Array.from({ length: 501 }, () => [5, 1, 1]) })).toBe(false);
    expect(bad({ zyx: Array.from({ length: 500 }, () => [5, 1, 1]) })).toBe(true);
  });

  it("rejects a negative length or a negative coordinate", () => {
    expect(markSchema.safeParse({ volumeId, line: { ...line, lengthMm: -1 } }).success).toBe(false);
    expect(markSchema.safeParse({ volumeId, line: { ...line, aZyx: [-1, 0, 0] } }).success).toBe(
      false,
    );
  });
});
