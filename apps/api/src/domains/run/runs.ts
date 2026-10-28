/**
 * The browser's run routes (`@voluma/contracts/run`), for signed-in users and guests:
 * start, list, get, cancel, resend keys, and list inputs. Every read goes through the
 * caller's `readerOf(user)`; the store applies it, so another org's run is a 404.
 * Visitor keys go to the in-memory vault, before the write that makes the run claimable
 * commits, and nowhere else; no handler logs a body.
 */
import { randomUUID } from "node:crypto";
import { type Run, resendKeysRequestSchema, startRunRequestSchema } from "@voluma/contracts/run";
import { Hono } from "hono";
import { readerOf, requireUser, type UserEnv } from "../../domain";
import type { Catalog } from "./catalog";
import type { KeyVault } from "./key-vault";
import type { RunStore } from "./run-store";

export interface RunsDeps {
  store: RunStore;
  catalog: Catalog;
  vault: KeyVault;
}

const tooManyKeys = { error: "Too many runs are waiting with keys; try again shortly." };

export function runsRoutes({ store, catalog, vault }: RunsDeps) {
  const app = new Hono<UserEnv>();
  app.use("/runs", requireUser);
  app.use("/runs/*", requireUser);
  app.use("/inputs", requireUser);

  app.post("/runs", async (c) => {
    const parsed = startRunRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.text(parsed.error.message, 400);
    const { workflowId, inputId, keys } = parsed.data;
    const entry = Object.hasOwn(catalog, workflowId) ? catalog[workflowId] : undefined;
    if (!entry) return c.json({ error: "unknown workflow" }, 404);
    const user = c.var.user;
    const reader = readerOf(user);
    const id = randomUUID();
    // The keys are in the vault before the run can be claimed: a claim holds back a
    // queued visitor run whose keys it can't find.
    if (keys && !vault.hold(id, reader.labId, keys)) return c.json(tooManyKeys, 429);
    try {
      const result = await store.start(
        reader,
        { userId: user.userId },
        { id, workflowId, pins: entry.pins, inputId, credentials: keys ? "visitor" : "voluma" },
      );
      if ("refused" in result) {
        vault.drop(id);
        switch (result.refused) {
          case "no-input":
            return c.json({ error: "unknown input" }, 404);
          case "unknown-org":
            return c.json({ error: "This organization cannot run work." }, 403);
          case "per-caller":
            return c.json({ error: "You already have a run in progress." }, 409);
          case "visitor-active":
            return c.json({ error: "Too many runs with your own keys are active." }, 429);
          case "daily":
            return c.json({ error: "The daily run limit is reached." }, 429);
          case "dollar":
            return c.json({ error: "The daily spending limit is reached." }, 429);
        }
      }
      return c.json(result.run satisfies Run);
    } catch (error) {
      vault.drop(id);
      throw error;
    }
  });

  app.get("/runs", async (c) => c.json({ runs: await store.list(readerOf(c.var.user)) }));

  app.get("/runs/:id", async (c) => {
    const run = await store.get(readerOf(c.var.user), c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });

  app.post("/runs/:id/cancel", async (c) => {
    const result = await store.cancel(readerOf(c.var.user), c.req.param("id"));
    if (result === "not-found") return c.json({ error: "not found" }, 404);
    if (result === "example") return c.json({ error: "Example runs are read-only." }, 403);
    vault.drop(result.id);
    return c.json(result);
  });

  app.post("/runs/:id/keys", async (c) => {
    const parsed = resendKeysRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.text(parsed.error.message, 400);
    const user = c.var.user;
    const reader = readerOf(user);
    const runId = c.req.param("id");
    const { keys } = parsed.data;
    // The store calls this once the run is the starter's and awaiting keys, before it is queued.
    let full = false;
    try {
      const result = await store.resume(reader, user.userId, runId, () => {
        full = !vault.hold(runId, reader.labId, keys);
        return !full;
      });
      if (full) return c.json(tooManyKeys, 429);
      if (result === "not-found") return c.json({ error: "not found" }, 404);
      if (result === "forbidden")
        return c.json({ error: "Only the run's starter can resend keys." }, 403);
      if (result === "conflict") return c.json({ error: "The run is not waiting for keys." }, 409);
      return c.json(result);
    } catch (error) {
      vault.drop(runId);
      throw error;
    }
  });

  app.get("/inputs", async (c) => c.json({ inputs: await store.listInputs(readerOf(c.var.user)) }));

  return app;
}
