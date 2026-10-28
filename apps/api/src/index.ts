/**
 * Voluma API, a Node server and the composition root: the only place that reads
 * env, builds adapters, and hands each domain its ports. Hono is used here only, to
 * route to the domains; each domain owns every path under its mount and gets the
 * path relative to it. Everything is under /api/.
 *
 * Start: `node --import tsx apps/api/src/index.ts` (not through pnpm, so node
 * receives SIGTERM; tsx because relative imports have no extensions).
 * Env: DATABASE_URL, VOLUMA_API_TOKEN, PORT (`pnpm dev` sets them; see tools/dev.mjs).
 */
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres from "postgres";
import { pgEventLog, pgHistory } from "./adapters";
import type { DomainHandler } from "./domain";
import { createReview } from "./domains/review";
import { createRun } from "./domains/run";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const client = postgres(required("DATABASE_URL"));
const db = drizzle(client, { casing: "snake_case" });

const mounts: [prefix: string, handler: DomainHandler][] = [
  [
    "/api/run",
    createRun({
      eventLog: pgEventLog(db),
      history: pgHistory(db),
      apiToken: required("VOLUMA_API_TOKEN"),
    }),
  ],
  ["/api/review", createReview({})],
];

const app = new Hono();
app.get("/health", (c) => c.text("ok"));
for (const [prefix, handler] of mounts) {
  app.all(`${prefix}/*`, async (c) => {
    const path = new URL(c.req.url).pathname.slice(prefix.length);
    return (await handler(c.req.raw, path)) ?? c.notFound();
  });
}
app.notFound((c) =>
  c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.text("Not found", 404),
);
app.onError((error, c) => {
  console.error(error);
  return c.req.path.startsWith("/api/")
    ? c.json({ error: "internal error" }, 500)
    : c.text("Internal error", 500);
});

const server = serve({ fetch: app.fetch, port: Number(required("PORT")) }, ({ port }) =>
  console.log(`api listening on :${port}`),
);

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
function shutdown() {
  server.close();
  if ("closeAllConnections" in server) server.closeAllConnections();
  client.end().then(() => process.exit(0));
}
