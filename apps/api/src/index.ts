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
 * GUEST_ORGANIZATION_ID with GUEST_SCOPE (lab|self, default lab) to let anyone in as a guest (the repo .env).
 * Run limits, per organization (LAB, JUDGES, DEMO) and number: RUN_LIMITS_<ORG>_PER_CALLER, _CONCURRENT,
 * _PER_DAY, _USD_PER_DAY, _VISITOR_ACTIVE; unset is no limit. Fails at startup if the database is unreachable or not migrated.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { drizzle } from "drizzle-orm/postgres-js";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import postgres from "postgres";
import { createAuth } from "./auth";
import { createReview } from "./domains/review";
import { createRun } from "./domains/run";
import type { Limits } from "./domains/run/admission";
import { catalog } from "./domains/run/catalog";
import { KeyVault } from "./domains/run/key-vault";
import { createNotifier } from "./domains/run/notifier";
import { pgEventLog } from "./domains/run/pg-event-log";
import { pgHistory } from "./domains/run/pg-history";
import { pgRunQueue } from "./domains/run/pg-queue";
import { pgRunReads } from "./domains/run/pg-runs";
import type { RunRecords } from "./ports";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

function guestScope(): "lab" | "self" {
  const scope = process.env.GUEST_SCOPE ?? "lab";
  if (scope !== "lab" && scope !== "self") throw new Error("GUEST_SCOPE must be lab or self");
  return scope;
}

/** A run limit from env: unset means no limit (`Infinity`). */
function limitNumber(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return Number.POSITIVE_INFINITY;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number`);
  return value;
}

/** An organization's run limits (`run.ts`), every number from `RUN_LIMITS_<ORG>_*` so it can change without a deploy. */
const limitsFromEnv = (org: "LAB" | "JUDGES" | "DEMO"): Limits => ({
  perCaller: limitNumber(`RUN_LIMITS_${org}_PER_CALLER`),
  concurrent: limitNumber(`RUN_LIMITS_${org}_CONCURRENT`),
  perDay: limitNumber(`RUN_LIMITS_${org}_PER_DAY`),
  usdPerDay: limitNumber(`RUN_LIMITS_${org}_USD_PER_DAY`),
  visitorActive: limitNumber(`RUN_LIMITS_${org}_VISITOR_ACTIVE`),
});

const client = postgres(required("DATABASE_URL"));
const db = drizzle(client, { casing: "snake_case" });

// The organizations and what each may run. Members sign in to `members`; the guest
// organization (auth.ts) is separate, and unset means the sign-in wall.
const members = [
  {
    id: required("WORKOS_LAB_ORGANIZATION_ID"),
    scope: "lab" as const,
    limits: limitsFromEnv("LAB"),
  },
  ...(process.env.WORKOS_JUDGES_ORGANIZATION_ID
    ? [
        {
          id: process.env.WORKOS_JUDGES_ORGANIZATION_ID,
          scope: "self" as const,
          limits: limitsFromEnv("JUDGES"),
        },
      ]
    : []),
];
const guest = process.env.GUEST_ORGANIZATION_ID
  ? { id: process.env.GUEST_ORGANIZATION_ID, scope: guestScope(), limits: limitsFromEnv("DEMO") }
  : null;
// An org missing here is no longer configured: its queued runs fail and its running ones stop.
const limits: ReadonlyMap<string, Limits> = new Map(
  [...members, ...(guest ? [guest] : [])].map((org) => [org.id, org.limits]),
);

const auth = createAuth({
  clientId: required("WORKOS_CLIENT_ID"),
  apiKey: required("WORKOS_API_KEY"),
  cookiePassword: required("WORKOS_COOKIE_PASSWORD"),
  // Who may sign in, and how much of the data each sees (auth.ts, domain.ts). No domain
  // reads an organization id.
  organizations: members.map(({ id, scope }) => ({ id, scope })),
  // Guests (auth.ts): a request with no credential is a guest in this organization.
  guest: guest && { organizationId: guest.id, scope: guest.scope },
  appUrl: required("APP_URL").replace(/\/$/, ""),
  apiToken: required("VOLUMA_API_TOKEN"),
});

/** Aborts at SIGTERM so open event streams end and the drain isn't held. */
const draining = new AbortController();
const reads = pgRunReads(db);
const notifier = createNotifier();
const queue = pgRunQueue(db, limits, new KeyVault(), notifier);
const eventLog = pgEventLog(db, notifier);

/** The review's read of a run: the run, then its whole log in one statement. */
const runRecords: RunRecords = {
  async load(reader, runId) {
    const run = await reads.get(reader, runId);
    const log = run && (await eventLog.stream(reader, runId, 0, 2 ** 31 - 1));
    return run && log ? { run, events: log.events } : null;
  },
};

const app = new Hono();
app.get("/health", (c) => c.text("ok"));
// A body over the limit is a 413 before anything reads it. Browsers get 256 KB (the key
// vault and the event log keep what they send). The runner is trusted, and a model's
// history row can be large (reasoning blobs, long tool calls), so /ingest/* gets 8 MB.
const browserLimit = bodyLimit({ maxSize: 256 * 1024 });
const runnerLimit = bodyLimit({ maxSize: 8 * 1024 * 1024 });
app.use("/api/*", (c, next) =>
  c.req.path.startsWith("/api/run/ingest/") ? runnerLimit(c, next) : browserLimit(c, next),
);
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
    reads,
    queue,
    eventLog,
    notifier,
    history: pgHistory(db),
    catalog,
    repo: "voluma-bio/voluma",
    shutdown: draining.signal,
  }),
);
app.route("/api/review", createReview({ runs: runRecords }));

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
await reads.ensureReferenceInputs([...limits.keys()]);

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
  draining.abort();
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
