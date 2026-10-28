/**
 * The review's run route, `GET /runs/:runId`: the run's review data
 * (`@voluma/contracts/review`), built from its event log on each read. Reads are scoped by
 * `readerOf`, so a run the caller can't read is 404, as in the run domain.
 */
import { Hono } from "hono";
import { readerOf, requireUser, type UserEnv } from "../../domain";
import type { ReviewDeps } from ".";
import { reviewRun } from "./review-run";

export function runRoutes({ runs }: ReviewDeps) {
  const app = new Hono<UserEnv>();
  app.use("/runs/*", requireUser);

  app.get("/runs/:runId", async (c) => {
    const record = await runs.load(readerOf(c.var.user), c.req.param("runId"));
    if (!record) return c.json({ error: "not found" }, 404);
    const review = reviewRun(record.run, record.events);
    if (!review) return c.json({ error: "this run has no plan yet" }, 409);
    return c.json(review);
  });

  return app;
}
