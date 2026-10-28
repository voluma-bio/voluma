/**
 * Run lane's API domain, mounted at /api/run/ (paths are relative to the mount). A short
 * mount list: each file owns its routes and its guard.
 *   runs.ts    the browser's run and input routes (users and guests)
 *   ingest.ts  the runner's claim, heartbeat, report, events and history (bearer token)
 * RunDeps lists what it needs; index.ts supplies the adapters (the queue is built with the limits and the key vault). The factory
 * returns a Hono app and does not know its mount. The Postgres adapters and tables are in
 * this directory.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../domain";
import type { Catalog } from "./catalog";
import { ingestRoutes } from "./ingest";
import type { LeasedEventLog } from "./pg-event-log";
import type { LeasedHistory } from "./pg-history";
import type { RunQueue } from "./pg-queue";
import type { RunReads } from "./pg-runs";
import { runsRoutes } from "./runs";

export interface RunDeps {
  reads: RunReads;
  queue: RunQueue;
  eventLog: LeasedEventLog;
  history: LeasedHistory;
  catalog: Catalog;
}

export function createRun(deps: RunDeps) {
  const app = new Hono<AppEnv>();
  app.route("/", runsRoutes(deps));
  app.route("/", ingestRoutes(deps));
  return app;
}
