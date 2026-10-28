/**
 * Voluma API, a Node server and the composition root: the only place that reads
 * env, builds adapters, and hands each domain its ports. Each domain is a Hono app
 * that owns every path under its mount (`app.route`) and does not know the mount.
 * Everything is under /api/.
 *
 * Start: `node --import tsx apps/api/src/index.ts` (not through pnpm, so node
 * receives SIGTERM; tsx because relative imports have no extensions).
 * Env: DATABASE_URL, VOLUMA_API_TOKEN, PORT, and optionally HOST (`pnpm dev` sets them;
 * see tools/dev.mjs). Fails at startup if the database is unreachable or not migrated.
 */
import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import postgres from "postgres";
import { createReview } from "./domains/review";
import { createRun } from "./domains/run";
import { pgEventLog } from "./domains/run/pg-event-log";
import { pgHistory } from "./domains/run/pg-history";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const client = postgres(required("DATABASE_URL"));
const db = drizzle(client, { casing: "snake_case" });

const app = new Hono();
app.get("/health", (c) => c.text("ok"));
app.route(
  "/api/run",
  createRun({
    eventLog: pgEventLog(db),
    history: pgHistory(db),
    apiToken: required("VOLUMA_API_TOKEN"),
  }),
);
app.route("/api/review", createReview({}));
app.notFound((c) =>
  c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.text("Not found", 404),
);
app.onError((error, c) => {
  // Middleware (bearerAuth) rejects by throwing; keep its status.
  if (error instanceof HTTPException) return error.getResponse();
  console.error(error);
  return c.req.path.startsWith("/api/")
    ? c.json({ error: "internal error" }, 500)
    : c.text("Internal error", 500);
});

// Fail fast on a bad URL, bad credentials or a missing migration; /health stays liveness-only.
await client`select 1 from threads limit 0`;

const server = serve(
  { fetch: app.fetch, port: Number(required("PORT")), hostname: process.env.HOST },
  ({ address, port }) => console.log(`api listening on ${address}:${port}`),
);

// Stay under the host's drain period (Railway's, once deployed).
const DRAIN_MS = 10_000;
let stopping = false;
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
// Dev delivers both SIGINT (terminal) and SIGTERM (launcher), hence the guard.
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await client.end({ timeout: 5 }).catch(console.error);
    process.exit(0);
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
  }, DRAIN_MS).unref();
}
