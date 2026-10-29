import { describe, expect, it } from "vitest";
import { readBodyFields } from "./body.ts";

describe("readBodyFields", () => {
  it("ignores model and max_tokens keys nested in a tool schema", () => {
    const body =
      '{"tools":[{"name":"t","input_schema":{"type":"object","model":"claude-haiku-4-5","max_tokens":1}}],"model":"claude-opus-4-1","max_tokens":32000,"messages":[]}';
    expect(readBodyFields(body)).toEqual({ model: "claude-opus-4-1", maxTokens: 32000 });
  });

  it("handles brackets and quotes inside strings", () => {
    const body = '{"text":"} {\\" \\"model\\":\\"x\\" [","model":"sam-3.1"}';
    expect(readBodyFields(body)).toEqual({ model: "sam-3.1", maxTokens: undefined });
  });

  it("refuses a repeated top-level key, an escaped key, and a missing model", () => {
    expect(readBodyFields('{"model":"a","x":{},"model":"b"}')).toMatch(/repeats/);
    expect(readBodyFields('{"mod\\u0065l":"a"}')).toMatch(/escape/);
    expect(readBodyFields('{"input":{"model":"a"}}')).toMatch(/no top-level model/);
    expect(readBodyFields('{"input":"' + "x".repeat(5000))).toMatch(/no top-level model/);
  });
});
