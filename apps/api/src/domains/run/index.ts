/**
 * Run lane's API domain, mounted at /api/run/ (paths are relative to the mount). A short
 * mount list: each file owns its routes and its guard.
 *   runs.ts    the browser's run and input routes (users and guests)
 *   ingest.ts  the runner's claim, heartbeat, report, events and history (bearer token)
 * RunDeps lists what it needs; index.ts supplies the adapters and the limits. The factory
 * returns a Hono app and does not know its mount. The Postgres adapters and tables are in
 * this directory.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../domain";
import type { Catalog } from "./catalog";
import { ingestRoutes } from "./ingest";
import type { KeyVault } from "./key-vault";
import type { LeasedEventLog, LeasedHistory, RunQueue, RunStore } from "./run-store";
import { runsRoutes } from "./runs";

export interface RunDeps {
  store: RunStore;
  queue: RunQueue;
  eventLog: LeasedEventLog;
  history: LeasedHistory;
  catalog: Catalog;
  vault: KeyVault;
}

export function createRun(deps: RunDeps) {
  const app = new Hono<AppEnv>();
  app.route("/", runsRoutes(deps));
  app.route("/", ingestRoutes(deps));
  return app;
}
