/**
 * Review lane's API domain, mounted at /api/review/: a mount list for run review data
 * and authorized scan downloads, with run chat and correction proposals still to come.
 * The composition root supplies ports; Review never imports the Run domain.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../domain";
import type { ReferenceArchive, ReviewInputs, RunRecords } from "../../ports";
import { inputRoutes } from "./inputs";
import { runRoutes } from "./runs";

export type ReviewDeps = {
  runs: RunRecords;
  inputs: ReviewInputs;
  referenceArchive: ReferenceArchive | null;
};

export function createReview(deps: ReviewDeps) {
  const app = new Hono<AppEnv>();
  app.route("/", runRoutes(deps));
  app.route("/", inputRoutes(deps));
  return app;
}
