import { describe, expect, it } from "vitest";
import { keySealer } from "./run-keys";

const keys = { metaApiKey: "meta-secret-key" };
const secret = "a".repeat(40);

describe("keySealer", () => {
  it("opens what it sealed", () => {
    const s = keySealer(secret);
    expect(s.open("run-1", s.seal("run-1", keys))).toEqual(keys);
  });
  it("refuses another run id and another secret", () => {
    const s = keySealer(secret);
    const sealed = s.seal("run-1", keys);
    expect(s.open("run-2", sealed)).toBeUndefined();
    expect(keySealer("b".repeat(40)).open("run-1", sealed)).toBeUndefined();
  });
});
