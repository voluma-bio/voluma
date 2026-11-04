/**
 * Throwaway operator: replay a staging run's recorded events into a new local run
 * at N× speed, so the local web app's live stream shows them as they arrive.
 *
 *   pnpm --filter @voluma/api replay:run -- --setup --user <id> --lab <id>
 *   pnpm --filter @voluma/api replay:run -- --play --from <events.jsonl> --target-seconds 100
 *
 * Never writes R2. Never uses the staging run id as the local id. Holds a fake
 * far-future lease so a runner cannot claim the local run.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eventLock } from "../domains/run/pg-event-log";
import { QUEUE_LOCK } from "../domains/run/pg-queue";
import { events, inputs, runs, studies, studyMembers } from "../domains/run/schema";
import type { ReplayMap } from "../replay-map";
import { loadReplayMap } from "../replay-map";
import { databaseUrl } from "./operator";

const SOURCE_RUN_ID = "ac073c0c-12b0-43e7-82f0-fe0e613116e5";
const SOURCE_STARTED = new Date("2026-11-04T21:25:34.781Z");
const MAP_FILE = resolve(import.meta.dirname, "../../../../.dev/replay.json");
const LEASE_HOLDER = "p1739-replay";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    setup: { type: "boolean" },
    play: { type: "boolean" },
    status: { type: "boolean" },
    user: { type: "string" },
    lab: { type: "string" },
    from: { type: "string" },
    "target-seconds": { type: "string" },
    speed: { type: "string" },
    replace: { type: "boolean" },
  },
});

function loadEvents(path: string) {
  const rows: {
    id: string;
    runId: string;
    threadId: string;
    seq: number;
    type: string;
    payload: unknown;
    createdAt: string;
  }[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as (typeof rows)[number];
    if (!row?.id || !row.seq || !row.type) continue;
    rows.push(row);
  }
  rows.sort((a, b) => a.seq - b.seq);
  return rows;
}

function writeMap(map: ReplayMap) {
  writeFileSync(MAP_FILE, `${JSON.stringify(map, null, 2)}\n`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setup() {
  const userId = values.user;
  const labId = values.lab;
  if (!userId || !labId) throw new Error("usage: --setup --user <id> --lab <id>");
  const existing = loadReplayMap();
  if (existing && !values.replace) {
    console.log(`already set up run ${existing.localRunId} study ${existing.localStudyId}`);
    return existing;
  }

  const url = databaseUrl({ writes: true });
  const client = postgres(url);
  const db = drizzle(client, { casing: "snake_case" });
  const localRunId = randomUUID();
  const localStudyId = randomUUID();
  const localInputId = randomUUID();
  const leaseToken = randomUUID();
  const map: ReplayMap = {
    localRunId,
    localStudyId,
    localInputId,
    sourceRunId: SOURCE_RUN_ID,
  };

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
    if (existing) {
      await tx.delete(events).where(eq(events.runId, existing.localRunId));
      await tx.delete(runs).where(eq(runs.id, existing.localRunId));
      await tx.delete(studyMembers).where(eq(studyMembers.studyId, existing.localStudyId));
      await tx.delete(studies).where(eq(studies.id, existing.localStudyId));
      await tx.delete(inputs).where(eq(inputs.id, existing.localInputId));
    }
    await tx.insert(inputs).values({
      id: localInputId,
      labId,
      source: "upload",
      uploadedBy: userId,
      name: "OA6-2RK",
      status: "ready",
      createdAt: SOURCE_STARTED,
    });
    await tx.insert(studies).values({
      id: localStudyId,
      labId,
      name: "OA6-2RK",
      workflowId: "mouse-oa",
      createdBy: userId,
      example: false,
      createdAt: SOURCE_STARTED,
    });
    await tx.insert(studyMembers).values({
      studyId: localStudyId,
      inputId: localInputId,
      subject: "OA6-2",
      group: null,
      attributes: { knee: "Right" },
      position: 0,
    });
    await tx.insert(runs).values({
      id: localRunId,
      labId,
      startedBy: userId,
      studyId: localStudyId,
      workflows: [{ repo: "voluma-bio/voluma", path: "workflows/mouse-oa" }],
      inputId: localInputId,
      credentials: "voluma",
      model: "meta/muse-wonder-1.0",
      thinking: "medium",
      harness: "agents",
      example: false,
      createdAt: SOURCE_STARTED,
      state: "running",
      startedAt: new Date("2026-11-04T21:25:36.343Z"),
      leaseHolder: LEASE_HOLDER,
      leaseToken,
      leaseExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
  });
  await client.end();
  writeMap(map);
  console.log(
    `replay run ${localRunId}\n  study ${localStudyId}\n  input ${localInputId}\n  source ${SOURCE_RUN_ID}\n  map ${MAP_FILE}`,
  );
  return map;
}

async function play() {
  const from = values.from;
  if (!from)
    throw new Error("usage: --play --from <events.jsonl> [--target-seconds 100] [--speed N]");
  const map = loadReplayMap();
  if (!map) throw new Error("run --setup first");
  const log = loadEvents(from);
  if (log.length === 0) throw new Error(`${from} has no events`);
  const t0 = Date.parse(log[0]!.createdAt);
  const t1 = Date.parse(log[log.length - 1]!.createdAt);
  const spanMs = Math.max(1, t1 - t0);
  const speed = values.speed
    ? Number(values.speed)
    : spanMs / (Number(values["target-seconds"] ?? 100) * 1000);
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("bad speed");
  const targetMs = spanMs / speed;
  console.log(
    `play ${log.length} events, real ${(spanMs / 60000).toFixed(1)} min, speed ${speed.toFixed(1)}×, video ~${(targetMs / 1000).toFixed(1)}s`,
  );

  const url = databaseUrl({ writes: true });
  const client = postgres(url);
  const db = drizzle(client, { casing: "snake_case" });

  await db.transaction(async (tx) => {
    await eventLock(tx, map.localRunId);
    await tx.delete(events).where(eq(events.runId, map.localRunId));
  });

  const wall0 = Date.now();
  let i = 0;
  let inserted = 0;
  while (i < log.length) {
    const due = t0 + (Date.now() - wall0) * speed;
    const batch: typeof log = [];
    while (i < log.length && Date.parse(log[i]!.createdAt) <= due && batch.length < 80) {
      batch.push(log[i]!);
      i += 1;
    }
    if (batch.length === 0) {
      const nextAt = Date.parse(log[i]!.createdAt);
      const wait = Math.min(50, Math.max(5, (nextAt - due) / speed));
      await sleep(wait);
      continue;
    }
    await db.transaction(async (tx) => {
      await eventLock(tx, map.localRunId);
      await tx.insert(events).values(
        batch.map((e) => ({
          runId: map.localRunId,
          id: e.id,
          threadId: e.threadId,
          seq: e.seq,
          type: e.type,
          payload: e.payload,
          createdAt: new Date(e.createdAt),
        })),
      );
    });
    inserted += batch.length;
    if (inserted === batch.length || inserted % 200 === 0 || i === log.length) {
      const last = batch[batch.length - 1]!;
      console.log(`  inserted ${inserted}/${log.length} seq ${last.seq} ${last.type}`);
    }
  }
  await client.end();
  const wall = Date.now() - wall0;
  console.log(`done ${inserted} events in ${(wall / 1000).toFixed(1)}s`);
  writeFileSync(
    resolve(MAP_FILE, "../replay-play.json"),
    `${JSON.stringify(
      {
        events: inserted,
        realSpanMs: spanMs,
        speed,
        wallMs: wall,
        targetMs,
        from,
        ended: false,
      },
      null,
      2,
    )}\n`,
  );
}

if (values.status) {
  console.log(JSON.stringify(loadReplayMap() ?? { error: "no map" }, null, 2));
} else if (values.setup) {
  await setup();
} else if (values.play) {
  await play();
} else {
  throw new Error("usage: replay:run --setup | --play | --status");
}
