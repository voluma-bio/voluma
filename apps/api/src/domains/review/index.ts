/**
 * Review lane's API domain, mounted at /api/review/: serving a run's review data
 * (`runs.ts`), and later the run chat and turning a correction into a rerun proposal. It
 * reads runs through ports in ReviewDeps that index.ts wires to the run domain, never by
 * importing domains/run.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../domain";
import type { RunRecords } from "../../ports";
import { runRoutes } from "./runs";

export type ReviewDeps = { runs: RunRecords };

export function createReview(deps: ReviewDeps) {
  const app = new Hono<AppEnv>();
  app.route("/", runRoutes(deps));
  return app;
}
