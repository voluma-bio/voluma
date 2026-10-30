/**
 * The browser's run routes (`@voluma/contracts/run`), for signed-in users and guests:
 * start (one run on a scan of a study), list, get, cancel and resend keys. Each handler parses, calls the queue or the
 * reads, and maps the answer. Each route names its own guard: the reads (list, get) take
 * `requireReader`, so a user reads through `readerOf(user)` (another org's run is a 404)
 * and the debug token reads every lab; the writes take `requireUser`. Visitor keys go straight to the queue,
 * which holds them in memory; no handler logs a body.
 */
import { randomUUID } from "node:crypto";
import { type Run, resendKeysRequestSchema, startRunRequestSchema } from "@voluma/contracts/run";
import { type Context, Hono } from "hono";
import { type AppEnv, parseJson, readerOf, requireReader, requireUser } from "../../domain";
import type { RunDeps } from ".";
import { refusalMessage } from "./admission";
import type { QueueRefusal } from "./pg-queue";

/** The answer to a write the queue refused. */
export function refusal(c: Context, refused: QueueRefusal, detail?: string[]) {
  switch (refused) {
    case "not-found":
      return c.json({ error: "not found" }, 404);
    case "forbidden":
      return c.json({ error: "Only the run's starter can resend keys." }, 403);
    case "conflict":
      return c.json({ error: "The run is not waiting for keys." }, 409);
    case "no-input":
      return c.json({ error: "unknown input" }, 404);
    case "no-study":
      return c.json({ error: "unknown study" }, 404);
    case "no-workflow":
      return c.json({ error: "unknown workflow" }, 404);
    case "bad-selection":
      return c.json(
        { error: `Not a measurement or score of this workflow: ${detail?.join(", ")}.` },
        400,
      );
    case "example":
      return c.json({ error: "Examples are read-only." }, 403);
    case "input-not-ready":
      return c.json({ error: "The scan is still uploading." }, 409);
    case "full":
      return c.json({ error: "Too many runs are waiting with keys; try again shortly." }, 429);
    default:
      return c.json({ error: refusalMessage[refused] }, refused === "per-caller" ? 409 : 429);
  }
}

export function runsRoutes({ reads, queue }: RunDeps) {
  const app = new Hono<AppEnv>();

  app.post("/runs", requireUser, async (c) => {
    const { studyId, inputId, selectedOutputs, notes, keys } = await parseJson(
      c,
      startRunRequestSchema,
    );
    const user = c.var.user;
    const result = await queue.start(
      readerOf(user),
      { userId: user.userId },
      {
        id: randomUUID(),
        studyId,
        inputId,
        selectedOutputs,
        notes,
        keys,
      },
    );
    return "refused" in result
      ? refusal(c, result.refused, result.detail)
      : c.json(result.run satisfies Run);
  });

  app.get("/runs", requireReader, async (c) => c.json({ runs: await reads.list(c.var.reader) }));

  app.get("/runs/:id", requireReader, async (c) => {
    const run = await reads.get(c.var.reader, c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });

  app.post("/runs/:id/cancel", requireUser, async (c) => {
    const result = await queue.cancel(readerOf(c.var.user), c.req.param("id"));
    return "refused" in result ? refusal(c, result.refused) : c.json(result.run satisfies Run);
  });

  app.post("/runs/:id/keys", requireUser, async (c) => {
    const { keys } = await parseJson(c, resendKeysRequestSchema);
    const user = c.var.user;
    const result = await queue.resume(readerOf(user), user.userId, c.req.param("id"), keys);
    return "refused" in result ? refusal(c, result.refused) : c.json(result.run satisfies Run);
  });

  return app;
}
