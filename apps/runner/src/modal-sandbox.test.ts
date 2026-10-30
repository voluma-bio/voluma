import { describe, expect, it } from "vitest";
import { isTransientMintFailure } from "./modal-sandbox.ts";

const spurious =
  '{"errors":[{"code":10042,"message":"Please enable R2 through the Cloudflare Dashboard."}]}';

describe("isTransientMintFailure", () => {
  it("retries rate limits, server errors and the spurious 403 10042", () => {
    expect(isTransientMintFailure(429, "")).toBe(true);
    expect(isTransientMintFailure(500, "")).toBe(true);
    expect(isTransientMintFailure(503, "")).toBe(true);
    expect(isTransientMintFailure(403, spurious)).toBe(true);
  });

  it("does not retry a bad token or other client errors", () => {
    expect(
      isTransientMintFailure(403, '{"errors":[{"code":10000,"message":"Authentication error"}]}'),
    ).toBe(false);
    expect(isTransientMintFailure(401, "")).toBe(false);
    expect(isTransientMintFailure(400, "")).toBe(false);
    expect(isTransientMintFailure(404, spurious)).toBe(false);
  });
});
