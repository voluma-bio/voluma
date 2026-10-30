/**
 * Review lane's API domain, mounted at /api/review/: a mount list for run review data
 * and a run's files, and a researcher's messages to it (`runs.ts`), and authorized scan downloads (`inputs.ts`).
 * The composition root supplies ports; Review never imports the Run domain.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../domain";
import type { ReferenceArchive, RunFiles, RunMessages, RunRecords } from "../../ports";
import { inputRoutes } from "./inputs";
import type { pgSnapshots } from "./pg-snapshots";
import { runRoutes } from "./runs";
import { snapshotRoutes } from "./snapshots";

export type ReviewDeps = {
  runs: RunRecords;
  snapshots: ReturnType<typeof pgSnapshots>;
  /** A researcher's message to a run: the Run domain stores it and reopens the run. */
  messages: RunMessages;
  /** Null without R2: run files are 503s. */
  files: RunFiles | null;
  referenceArchive: ReferenceArchive | null;
};

export function createReview(deps: ReviewDeps) {
  const app = new Hono<AppEnv>();
  app.route("/", runRoutes(deps));
  app.route("/", inputRoutes(deps));
  app.route("/", snapshotRoutes(deps));
  return app;
}
