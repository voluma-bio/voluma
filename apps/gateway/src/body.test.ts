import { describe, expect, it } from "vitest";
import { BodyScanner } from "./body.ts";

/** Admission reads the first `window` bytes; the rest is pushed afterwards, as it is forwarded. */
function scan(body: string, window = 4096) {
  const scanner = new BodyScanner();
  scanner.push(body.slice(0, window));
  const fields = scanner.fields();
  return { fields, later: scanner.push(body.slice(window)) };
}

describe("BodyScanner", () => {
  it("ignores model keys nested in a tool schema", () => {
    const body =
      '{"tools":[{"name":"t","input_schema":{"type":"object","model":"claude-haiku-4-5","max_tokens":1}}],"model":"claude-opus-4-1","max_tokens":32000,"messages":[]}';
    expect(scan(body).fields).toEqual({ model: "claude-opus-4-1" });
  });

  it("handles brackets and quotes inside strings", () => {
    const body = '{"text":"} {\\" \\"model\\":\\"x\\" [","model":"sam-3.1"}';
    expect(scan(body).fields).toEqual({ model: "sam-3.1" });
  });

  it("refuses a repeated key, an escaped key, and a missing model", () => {
    expect(scan('{"model":"a","x":{},"model":"b"}').fields).toMatch(/repeats/);
    expect(scan('{"mod\\u0065l":"a"}').fields).toMatch(/escape/);
    expect(scan('{"input":{"model":"a"}}').fields).toMatch(/no top-level model/);
    expect(scan(`{"input":"${"x".repeat(5000)}`).fields).toMatch(/no top-level model/);
  });

  it("catches a second model after the admission window", () => {
    const body = `{"model":"sam-3.1","pad":"${"x".repeat(5000)}","model":"llama"}`;
    const { fields, later } = scan(body);
    expect(fields).toEqual({ model: "sam-3.1" });
    expect(later).toMatch(/repeats the key "model"/);
  });

  it("is not fooled by chunk boundaries", () => {
    const body = `{"model":"a","pad":"${"x".repeat(50)}","model":"b"}`;
    const scanner = new BodyScanner();
    for (const c of body) scanner.push(c);
    expect(scanner.push("")).toMatch(/repeats/);
  });

  it("does not refuse a valid body at any cut after the model", () => {
    const body = '{"model":"sam-3.1","messages" : [], "x": 1}';
    for (let cut = body.indexOf(","); cut <= body.length; cut++) {
      const { fields, later } = scan(body, cut);
      expect(fields).toEqual({ model: "sam-3.1" });
      expect(later).toBeUndefined();
    }
  });
});
