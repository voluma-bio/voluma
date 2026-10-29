/** Reservation and cost arithmetic: a wrong number here is a silent cap breach or a wrong bill. */
import { describe, expect, it } from "vitest";
import { fits } from "./calls.ts";
import { observeLine } from "./observe.ts";
import { costUsd, type Observed, reservationUsd } from "./prices.ts";

describe("reservation", () => {
  it("holds SAM's 15,000-frame maximum, which the request cannot lower", () => {
    expect(reservationUsd("meta", "sam-3.1", 1)).toBeCloseTo(3);
    expect(reservationUsd("meta", "sam-3.1", undefined)).toBeCloseTo(3);
  });
  it("holds max_tokens at the output price (claude-sonnet-4-5: $15/M)", () => {
    expect(reservationUsd("anthropic", "claude-sonnet-4-5", 4096)).toBeCloseTo(0.06144);
  });
  it("refuses a model with no price", () => {
    expect(reservationUsd("anthropic", "no-such-model", 10)).toBeNull();
  });
  it("uses the dearest tier's output price", () => {
    expect(reservationUsd("openai", "gpt-5.6-luna", 1_000_000)).toBeCloseTo(1.8);
  });
});

describe("cost", () => {
  it("bills SAM per frame with a 50-frame minimum", () => {
    expect(costUsd("meta", "sam-3.1", { frames: 1000 })).toBeCloseTo(0.2);
    expect(costUsd("meta", "sam-3.1", { frames: 3 })).toBeCloseTo(0.01);
  });
  it("counts Anthropic's cache apart from its input", () => {
    const seen: Observed = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheWriteTokens: 400,
    };
    // 1000*3 + 2000*0.3 + 400*3.75 + 500*15, per million
    expect(costUsd("anthropic", "claude-sonnet-4-5", seen)).toBeCloseTo(0.0126);
  });
  it("takes the cached part out of a Responses input count", () => {
    const seen: Observed = { inputTokens: 3000, outputTokens: 100, cacheReadTokens: 2000 };
    // (1000*0.2 + 2000*0.02 + 100*1.2) per million
    expect(costUsd("openai", "gpt-5.6-luna", seen)).toBeCloseTo(0.00036);
  });
  it("is unknown when the reply reported no usage", () => {
    expect(costUsd("anthropic", "claude-sonnet-4-5", {})).toBeNull();
  });
});

describe("the cap", () => {
  it("admits up to the cap and no further", () => {
    expect(fits(7, 3, 10)).toBe(true);
    expect(fits(7.01, 3, 10)).toBe(false);
    // three $3.1 reservations in a $10 cap: the third fits, the fourth cannot
    expect(fits(6.2, 3.1, 10)).toBe(true);
    expect(fits(9.3, 3.1, 10)).toBe(false);
  });
});

describe("reading usage from a reply", () => {
  it("reads Anthropic's two events and keeps the final output count", () => {
    const seen: Observed = {};
    observeLine(
      'data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":25,"cache_read_input_tokens":3,"output_tokens":1}}}',
      seen,
    );
    observeLine('data: {"type":"message_delta","delta":{},"usage":{"output_tokens":15}}', seen);
    expect(seen).toEqual({ inputTokens: 25, cacheReadTokens: 3, outputTokens: 15 });
  });
  it("reads a Responses completion and SAM's frames", () => {
    const seen: Observed = {};
    observeLine(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":9,"input_tokens_details":{"cached_tokens":4},"output_tokens":7},"video_frames_processed":120}}',
      seen,
    );
    expect(seen).toEqual({ inputTokens: 9, cacheReadTokens: 4, outputTokens: 7, frames: 120 });
  });
  it("ignores usage-looking text a model wrote inside a string", () => {
    const seen: Observed = {};
    observeLine('data: {"delta":{"text":"{\\"usage\\":{\\"input_tokens\\":99}}"}}', seen);
    expect(seen).toEqual({});
  });
});
