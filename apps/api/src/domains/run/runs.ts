/**
 * The browser's run routes (`@voluma/contracts/run`), for signed-in users and guests:
 * start (one run on a scan of a study), list, get, cancel and resend keys. Each handler parses, calls the queue or the
 * reads, and maps the answer. Each route names its own guard: the reads (list, get) take
 * `requireReader`, so a user reads through `readerOf(user)` (another org's run is a 404)
 * and the debug token reads every lab; the writes take `requireUser`. Visitor keys go straight to the queue,
 * which holds them in memory; no handler logs a body.
 */
import { randomUUID } from "node:crypto";
import {
  acceptRefusal,
  type Run,
  type RunRead,
  resendKeysRequestSchema,
  startRunRequestSchema,
} from "@voluma/contracts/run";
import { Hono } from "hono";
import {
  type AppEnv,
  callerOf,
  type Principal,
  parseJson,
  readerOf,
  requireReader,
  requireUser,
  type UserPrincipal,
} from "../../domain";
import type { RunDeps } from ".";

/** What the debug token sees where a user would see what they may do: it only reads. */
const READ_ONLY_TOKEN = "This token only reads runs.";

export function runsRoutes({ reads, queue }: RunDeps) {
  const app = new Hono<AppEnv>();

  /** The run with what `user` may do on it now (`runReadSchema`); no user: the debug token. */
  const readOf = async (user: UserPrincipal | undefined, run: Run): Promise<RunRead> => ({
    ...run,
    cannotMessage: user
      ? await queue.cannotMessage(readerOf(user), callerOf(user), run)
      : READ_ONLY_TOKEN,
    cannotAccept: user ? (acceptRefusal(run)?.message ?? null) : READ_ONLY_TOKEN,
  });
  const userOf = (principal: Principal) => (principal.kind === "user" ? principal : undefined);

  app.post("/runs", requireUser, async (c) => {
    const { studyId, inputId, selectedOutputs, notes, keys } = await parseJson(
      c,
      startRunRequestSchema,
    );
    const user = c.var.user;
    const result = await queue.start(readerOf(user), callerOf(user), {
      id: randomUUID(),
      studyId,
      inputId,
      selectedOutputs,
      notes,
      keys,
    });
    return c.json(result.run satisfies Run);
  });

  app.get("/runs", requireReader, async (c) => c.json({ runs: await reads.list(c.var.reader) }));

  app.get("/runs/:id", requireReader, async (c) => {
    const run = await reads.get(c.var.reader, c.req.param("id"));
    return run
      ? c.json(await readOf(userOf(c.var.principal), run))
      : c.json({ error: "not found" }, 404);
  });

  app.post("/runs/:id/cancel", requireUser, async (c) => {
    const result = await queue.cancel(readerOf(c.var.user), c.req.param("id"));
    return c.json(await readOf(c.var.user, result.run));
  });

  app.post("/runs/:id/keys", requireUser, async (c) => {
    const { keys } = await parseJson(c, resendKeysRequestSchema);
    const user = c.var.user;
    const result = await queue.resume(readerOf(user), user.userId, c.req.param("id"), keys);
    return c.json(await readOf(user, result.run));
  });

  return app;
}
