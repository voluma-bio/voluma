/** Importing the catalog parses every bundled workflow's files, so a bad file fails CI, not the API's boot. */
import { describe, expect, it } from "vitest";
import { catalog } from "./bundled";

describe("catalog", () => {
  it.each(Object.values(catalog))("$id parses with outputs", (workflow) => {
    expect(workflow.outputs.length).toBeGreaterThan(0);
  });
});
