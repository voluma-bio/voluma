/**
 * Run lane's API domain, mounted at /api/run/ (paths are relative to the mount). A short
 * mount list: each file owns its routes and its guard.
 *   runs.ts    the run routes (users and guests; the reads also take the debug token)
 *   studies.ts the browser's study routes: create (with its first runs), list, get
 *   inputs.ts  the browser's scans: list, and upload (members); `scripts/upload-scan.ts` is the CLI for it
 *   stream.ts  the server-sent event stream of a run's stored events (users, debug token)
 *   ingest.ts  the runner's claim, heartbeat, report, events and history (bearer token)
 * RunDeps lists what it needs; index.ts supplies the adapters (the queue is built with the limits and the key vault). The factory
 * returns a Hono app and does not know its mount. The Postgres adapters and tables are in
 * this directory.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../domain";
import { ingestRoutes } from "./ingest";
import { inputsRoutes, type UploadLimits } from "./inputs";
import type { Notifier } from "./notifier";
import type { LeasedEventLog } from "./pg-event-log";
import type { LeasedHistory } from "./pg-history";
import type { RunQueue } from "./pg-queue";
import type { RunReads } from "./pg-runs";
import type { StudyReads } from "./pg-studies";
import type { PgUploads } from "./pg-uploads";
import type { Uploads } from "./r2-uploads";
import { runsRoutes } from "./runs";
import { streamRoutes } from "./stream";
import { studiesRoutes } from "./studies";

export interface RunDeps {
  reads: RunReads;
  studies: StudyReads;
  queue: RunQueue;
  eventLog: LeasedEventLog;
  history: LeasedHistory;
  /** Wakes open streams when a run's events or state change. */
  notifier: Notifier;
  /** Upload rows, and the object store their files go to (presigned, never through the API); null when R2 is not configured. */
  uploadStore: PgUploads;
  objects: Uploads | null;
  uploadLimits: UploadLimits;
  /** Aborts when the API starts draining; open streams end so the drain isn't held. */
  shutdown: AbortSignal;
}

export function createRun(deps: RunDeps) {
  const app = new Hono<AppEnv>();
  app.route("/", runsRoutes(deps));
  app.route("/", studiesRoutes(deps));
  app.route("/", inputsRoutes(deps));
  app.route("/", streamRoutes(deps));
  app.route("/", ingestRoutes(deps));
  return app;
}
