/**
 * A workflow's `outputs.yaml` read from a checkout, for the API: it validates a start's selected
 * outputs against it. Node only (the web build bundles the same files with `output-catalogs.ts`;
 * a run's runner reads its own snapshot, `loadWorkflow`). A file that fails `outputCatalogSchema`
 * throws, which stops the API from starting.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type OutputCatalog, outputCatalogSchema } from "@voluma/contracts/output-catalog";
import { parse } from "yaml";

/** `dir` is the workflow's directory relative to `root`, e.g. `workflows/mouse-oa`. */
export const readOutputCatalog = (root: string, dir: string): OutputCatalog =>
  outputCatalogSchema.parse(parse(readFileSync(join(root, dir, "outputs.yaml"), "utf8")));
