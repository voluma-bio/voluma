/**
 * Run lane's API domain, mounted at /api/run/ (paths are relative to the mount). A short
 * mount list: each file owns its routes and its guard.
 *   runs.ts    the browser's run and input routes (users and guests)
 *   stream.ts  the browser's server-sent event stream of a run's stored events
 *   ingest.ts  the runner's claim, heartbeat, report, events and history (bearer token)
 * RunDeps lists what it needs; index.ts supplies the adapters (the queue is built with the limits and the key vault). The factory
 * returns a Hono app and does not know its mount. The Postgres adapters and tables are in
 * this directory.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../domain";
import type { Catalog } from "./catalog";
import { ingestRoutes } from "./ingest";
import type { Notifier } from "./notifier";
import type { LeasedEventLog } from "./pg-event-log";
import type { LeasedHistory } from "./pg-history";
import type { RunQueue } from "./pg-queue";
import type { RunReads } from "./pg-runs";
import { runsRoutes } from "./runs";
import { streamRoutes } from "./stream";

export interface RunDeps {
  reads: RunReads;
  queue: RunQueue;
  eventLog: LeasedEventLog;
  history: LeasedHistory;
  /** Wakes open streams when a run's events or state change. */
  notifier: Notifier;
  catalog: Catalog;
  /** The checkout the deployed API and runner share: a run pins this repo at this commit. */
  source: { repo: string; commit: string };
  /** Aborts when the API starts draining; open streams end so the drain isn't held. */
  shutdown: AbortSignal;
}

export function createRun(deps: RunDeps) {
  const app = new Hono<AppEnv>();
  app.route("/", runsRoutes(deps));
  app.route("/", streamRoutes(deps));
  app.route("/", ingestRoutes(deps));
  return app;
}
