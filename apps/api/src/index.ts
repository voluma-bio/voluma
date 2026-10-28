/**
 * Voluma API, a Node server and the composition root: the only place that reads
 * env, builds adapters, and hands each domain its ports. Each domain is a Hono app
 * that owns every path under its mount (`app.route`) and does not know the mount.
 * Everything is under /api/. When apps/web/dist exists (after `pnpm --filter @voluma/web
 * build`) it also serves the built web app, with an SPA fallback.
 *
 * Start: `cd apps/api && node --import tsx src/index.ts` (tsx resolves only from there; not through pnpm, so node
 * receives SIGTERM; tsx because relative imports have no extensions).
 * Env: DATABASE_URL, VOLUMA_API_TOKEN, APP_URL, PORT, optionally HOST (`pnpm dev` sets
 * them; see tools/dev.mjs), and WORKOS_CLIENT_ID, WORKOS_API_KEY, WORKOS_COOKIE_PASSWORD,
 * WORKOS_LAB_ORGANIZATION_ID, and optionally WORKOS_JUDGES_ORGANIZATION_ID, and
 * GUEST_ORGANIZATION_ID with GUEST_SCOPE (lab|self, default lab) to let anyone in as a guest (the repo .env). Fails at startup if the database is unreachable or not migrated.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { drizzle } from "drizzle-orm/postgres-js";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import postgres from "postgres";
import { createAuth } from "./auth";
import { createReview } from "./domains/review";
import { createRun } from "./domains/run";
import { pgEventLog } from "./domains/run/pg-event-log";
import { pgHistory } from "./domains/run/pg-history";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

function guestScope() {
  const scope = process.env.GUEST_SCOPE ?? "lab";
  if (scope !== "lab" && scope !== "self") throw new Error("GUEST_SCOPE must be lab or self");
  return scope;
}

const client = postgres(required("DATABASE_URL"));
const db = drizzle(client, { casing: "snake_case" });

const auth = createAuth({
  clientId: required("WORKOS_CLIENT_ID"),
  apiKey: required("WORKOS_API_KEY"),
  cookiePassword: required("WORKOS_COOKIE_PASSWORD"),
  // Who may sign in, and how much of the data each sees (auth.ts, domain.ts). No domain
  // reads an organization id. The Judges organization is optional: unset means not allowed.
  organizations: [
    { id: required("WORKOS_LAB_ORGANIZATION_ID"), scope: "lab" },
    ...(process.env.WORKOS_JUDGES_ORGANIZATION_ID
      ? [{ id: process.env.WORKOS_JUDGES_ORGANIZATION_ID, scope: "self" as const }]
      : []),
  ],
  // Guests (auth.ts): a request with no credential is a guest in this organization.
  // Unset means the sign-in wall.
  guest: process.env.GUEST_ORGANIZATION_ID
    ? { organizationId: process.env.GUEST_ORGANIZATION_ID, scope: guestScope() }
    : null,
  appUrl: required("APP_URL").replace(/\/$/, ""),
  apiToken: required("VOLUMA_API_TOKEN"),
});

const app = new Hono();
app.get("/health", (c) => c.text("ok"));
// Every /api request is authenticated here, in this order (auth.ts): the bearer and
// CSRF checks, which do no I/O; the routes that write the session cookie; the session
// cookie and the 401 for no principal; then the routes that need a user.
app.use("/api/*", ...auth.guards);
app.route("/api/auth", auth.sessionRoutes);
app.use("/api/*", ...auth.session);
app.route("/api/auth", auth.userRoutes);
app.route(
  "/api/run",
  createRun({
    eventLog: pgEventLog(db),
    history: pgHistory(db),
  }),
);
app.route("/api/review", createReview({}));

const isApi = (path: string) => path === "/api" || path.startsWith("/api/");
const webDist = resolve(import.meta.dirname, "../../web/dist");
if (existsSync(webDist)) {
  // Vite hashes the names under assets/, so those never change; everything else
  // (index.html above all) must be revalidated to pick up a new deploy.
  const onFound = (path: string, c: Context) =>
    c.header(
      "Cache-Control",
      path.startsWith(`${webDist}/assets/`) ? "public, max-age=31536000, immutable" : "no-cache",
    );
  const files = serveStatic({ root: webDist, onFound });
  const spa = serveStatic({ root: webDist, path: "index.html", onFound });
  app.get("*", (c, next) => (isApi(c.req.path) ? next() : files(c, next)));
  // The app shell for client-side routes, which have no extension; a missing file
  // (/favicon.ico, /assets/x.js) is a real 404.
  app.get("*", (c, next) =>
    isApi(c.req.path) || /\.[^/]+$/.test(c.req.path) ? next() : spa(c, next),
  );
}
app.notFound((c) =>
  isApi(c.req.path) ? c.json({ error: "not found" }, 404) : c.text("Not found", 404),
);
app.onError((error, c) => {
  // Middleware may reject by throwing; keep its status.
  if (error instanceof HTTPException) return error.getResponse();
  console.error(error);
  return isApi(c.req.path)
    ? c.json({ error: "internal error" }, 500)
    : c.text("Internal error", 500);
});

// Fail fast on a bad URL, bad credentials or a missing migration; /health stays liveness-only.
await client`select 1 from threads limit 0`;

const server = serve(
  { fetch: app.fetch, port: Number(required("PORT")), hostname: process.env.HOST },
  ({ address, port }) => console.log(`api listening on ${address}:${port}`),
);

// Stay under the host's drain period (Railway's draining period, 30 s: apps/api/.context/deploy.md).
const DRAIN_MS = 10_000;
let stopping = false;
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
// Dev delivers both SIGINT (terminal) and SIGTERM (launcher), hence the guard.
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("shutting down: draining connections");
  server.close(async () => {
    await client.end({ timeout: 5 }).catch(console.error);
    console.log("shutdown complete");
    process.exit(0);
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
  setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
  }, DRAIN_MS).unref();
}
