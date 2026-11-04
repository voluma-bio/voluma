/**
 * The workflows' output catalogs (`outputs.yaml`), bundled for the web app: names, units, label
 * maps and shapes for the review and the study pages, read at build time, since the API serves
 * no workflow files. A run snapshots its own commit, which may be later than this
 * bundle: an output the bundle lacks shows its id. Vite-only (`?raw`): the API and runner read the
 * catalog from the run's snapshot (`loadWorkflow`), never from here. A file that fails
 * `outputCatalogSchema` throws at import.
 */
import { type OutputCatalog, outputCatalogSchema } from "@voluma/contracts/output-catalog";
import { parse } from "yaml";
import mouseOa from "../../../workflows/mouse-oa/outputs.yaml?raw";

const catalogs: Record<string, OutputCatalog> = {
  "workflows/mouse-oa": outputCatalogSchema.parse(parse(mouseOa)),
};

/** The catalog of a run's pinned workflow path; empty for a workflow with none bundled. */
export const outputCatalogOf = (path: string | undefined): OutputCatalog =>
  (path !== undefined && catalogs[path]) || [];
