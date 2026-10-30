/**
 * Review lane's API domain, mounted at /api/review/: a mount list for run review data
 * and a run's files (`runs.ts`) and authorized scan downloads (`inputs.ts`), with run chat and correction proposals still to come.
 * The composition root supplies ports; Review never imports the Run domain.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../domain";
import type { ReferenceArchive, ReviewInputs, RunFiles, RunRecords } from "../../ports";
import { inputRoutes } from "./inputs";
import type { pgSnapshots } from "./pg-snapshots";
import { runRoutes } from "./runs";
import { snapshotRoutes } from "./snapshots";

export type ReviewDeps = {
  runs: RunRecords;
  snapshots: ReturnType<typeof pgSnapshots>;
  /** Null without R2: run files are 503s. */
  files: RunFiles | null;
  inputs: ReviewInputs;
  referenceArchive: ReferenceArchive | null;
};

export function createReview(deps: ReviewDeps) {
  const app = new Hono<AppEnv>();
  app.route("/", runRoutes(deps));
  app.route("/", inputRoutes(deps));
  app.route("/", snapshotRoutes(deps));
  return app;
}
