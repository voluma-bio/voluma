import { describe, expect, it } from "vitest";
import { docstringSummary } from "./docstring";

// A script that parsed to the wrong line would put a wrong description in every agent's prompt.
describe("docstringSummary", () => {
  it("takes the first line, whatever precedes or follows it", () => {
    expect(docstringSummary("a.py", '"""Cut a region.\n\nMore."""\nimport x')).toBe(
      "Cut a region.",
    );
    expect(docstringSummary("a.py", '#!/usr/bin/env python\n# c\n\n"""\nCut a region.\n"""')).toBe(
      "Cut a region.",
    );
    expect(docstringSummary("a.py", "r'''Cut a region.'''")).toBe("Cut a region.");
  });

  it("refuses a script without a module docstring", () => {
    expect(() => docstringSummary("a.py", 'import x\n"""not first"""')).toThrow(/docstring/);
  });
});
