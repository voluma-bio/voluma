/**
 * The browser's run routes (`@voluma/contracts/run`), for signed-in users and guests:
 * start, list, get, cancel and resend keys. Each handler parses, calls the
 * queue or the reads, and maps the answer. Every read goes through the caller's
 * `readerOf(user)`, so another org's run is a 404. Visitor keys go straight to the queue,
 * which holds them in memory; no handler logs a body.
 */
import { randomUUID } from "node:crypto";
import { type Run, resendKeysRequestSchema, startRunRequestSchema } from "@voluma/contracts/run";
import { type Context, Hono } from "hono";
import { parseJson, readerOf, requireUser, type UserEnv } from "../../domain";
import type { RunDeps } from ".";
import { type Refusal, refusalMessage } from "./admission";

/** The answer to a start or resend the queue refused. */
function refusal(c: Context, refused: Refusal | "no-input" | "input-not-ready" | "full") {
  if (refused === "no-input") return c.json({ error: "unknown input" }, 404);
  if (refused === "input-not-ready") return c.json({ error: "The scan is still uploading." }, 409);
  if (refused === "full") {
    return c.json({ error: "Too many runs are waiting with keys; try again shortly." }, 429);
  }
  return c.json({ error: refusalMessage[refused] }, refused === "per-caller" ? 409 : 429);
}

export function runsRoutes({ reads, queue, catalog, repo }: RunDeps) {
  const app = new Hono<UserEnv>();
  app.use("/runs", requireUser);
  app.use("/runs/*", requireUser);

  app.post("/runs", async (c) => {
    const { workflowId, inputId, selectedOutputs, notes, keys } = await parseJson(
      c,
      startRunRequestSchema,
    );
    const entry = Object.hasOwn(catalog, workflowId) ? catalog[workflowId] : undefined;
    if (!entry) return c.json({ error: "unknown workflow" }, 404);
    const user = c.var.user;
    const result = await queue.start(
      readerOf(user),
      { userId: user.userId },
      {
        id: randomUUID(),
        workflowId,
        pins: [{ repo, path: entry.workflow }],
        inputId,
        selectedOutputs,
        notes,
        keys,
      },
    );
    return "refused" in result ? refusal(c, result.refused) : c.json(result.run satisfies Run);
  });

  app.get("/runs", async (c) => c.json({ runs: await reads.list(readerOf(c.var.user)) }));

  app.get("/runs/:id", async (c) => {
    const run = await reads.get(readerOf(c.var.user), c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });

  app.post("/runs/:id/cancel", async (c) => {
    const result = await queue.cancel(readerOf(c.var.user), c.req.param("id"));
    if (result === "not-found") return c.json({ error: "not found" }, 404);
    if (result === "example") return c.json({ error: "Example runs are read-only." }, 403);
    return c.json(result);
  });

  app.post("/runs/:id/keys", async (c) => {
    const { keys } = await parseJson(c, resendKeysRequestSchema);
    const user = c.var.user;
    const result = await queue.resume(readerOf(user), user.userId, c.req.param("id"), keys);
    if (result === "not-found") return c.json({ error: "not found" }, 404);
    if (result === "forbidden")
      return c.json({ error: "Only the run's starter can resend keys." }, 403);
    if (result === "conflict") return c.json({ error: "The run is not waiting for keys." }, 409);
    if (typeof result === "string") return refusal(c, result);
    return c.json(result);
  });

  return app;
}
