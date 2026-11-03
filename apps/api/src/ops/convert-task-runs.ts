/**
 * Operator script (step 1 of retiring the task loop): reads every stored task-loop run, converts
 * its outputs and To check items into the agent loop's events (`convert-task-run.ts`), checks
 * the files they name in R2 (reads only), and writes the migration that applies the result.
 *   pnpm --filter @voluma/api convert:task-runs --staging <url> --out drizzle/0025_convert_task_runs.sql --report <file.md> [--save <dir>]
 *   pnpm --filter @voluma/api convert:task-runs --from <dir> ...
 * `--staging` lists the runs with VOLUMA_DEBUG_TOKEN and reads each run's stored events from
 * `GET /api/run/runs/:id/stream` (leaving out its `event: live` frames); `--save` keeps what it
 * read, as `<id>.ndjson` (events) and `<id>.run.json` (the run row), which `--from` reads back.
 * Reads the R2 settings from the repo .env; `--skip-r2` assumes every file is there.
 *
 * The migration has two parts. Per run, one INSERT of the new events, applied to the run with that
 * id or to a copy of its log under another id (an example seeded from it): the same first
 * `revision.started` and as many events. Then a tail for every database, whatever its runs hold:
 * the task-only event types go, `reply` becomes `agent.message`, `thread.started` gets a `role` and
 * loses its task fields, `person.message` loses its task fields, and the runs and their root thread say `agents`. Both parts are idempotent: the INSERT
 * needs the `revision.started` the tail deletes. `payload` is `json` (some hold \u0000), so
 * each is read only inside a CASE on its own type.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { RunEvent } from "@voluma/contracts/events";
import { outputCatalogSchema } from "@voluma/contracts/output-catalog";
import { evidenceKey, evidencePrefix, outputsPrefix } from "@voluma/contracts/r2";
import type { ObjectInfo } from "@voluma/object-store";
import { parse } from "yaml";
import { convertRun, type FileCheck, type NewEvent, type RunReport } from "./convert-task-run";
import { r2FromEnv } from "./r2-dir";

const MIGRATION_TAIL = `
-- Every database, whatever its runs hold. Task runs are those with no harness or "tasks"; only
-- ended ones are touched, since a live task-loop run still needs its task events.
-- A payload holding \u0000 makes the jsonb casts and ->> below fail, which aborts the migration; the
-- staging runs hold it only in tool.result, which no statement here reads.
-- reply -> agent.message
UPDATE "events"
SET "type" = 'agent.message',
    "payload" = jsonb_build_object('from', 'main', 'to', 'researcher', 'text', "payload"->>'text')::json
WHERE "type" = 'reply'
  AND "run_id" IN (SELECT "id" FROM "runs" WHERE ("harness" IS NULL OR "harness" = 'tasks') AND "state" = 'ended');
--> statement-breakpoint
-- person.message loses its task fields (a Go and marks name a task's blocks); a message left with no text was only that.
UPDATE "events"
SET "payload" = ("payload"::jsonb - 'taskId' - 'itemId' - 'go' - 'marks')::json
WHERE "type" = 'person.message'
  AND "run_id" IN (SELECT "id" FROM "runs" WHERE ("harness" IS NULL OR "harness" = 'tasks') AND "state" = 'ended')
  AND CASE WHEN "type" = 'person.message' THEN "payload"::jsonb ?| ARRAY['taskId', 'itemId', 'go', 'marks'] END;
--> statement-breakpoint
DELETE FROM "events"
WHERE "type" = 'person.message'
  AND "run_id" IN (SELECT "id" FROM "runs" WHERE ("harness" IS NULL OR "harness" = 'tasks') AND "state" = 'ended')
  AND CASE WHEN "type" = 'person.message' THEN btrim(coalesce("payload"->>'text', '')) END = '';
--> statement-breakpoint
-- The task loop's own events, and the outputs backups only its corrections wrote.
DELETE FROM "events"
WHERE "type" IN ('attempt.opened', 'task', 'checkpoint', 'output', 'plan.changed', 'revision.started', 'ask', 'answer', 'check.accepted', 'review.completed', 'outputs.backed-up', 'outputs.restored', 'outputs.discarded')
  AND "run_id" IN (SELECT "id" FROM "runs" WHERE ("harness" IS NULL OR "harness" = 'tasks') AND "state" = 'ended');
--> statement-breakpoint
-- The root thread names its loop.
UPDATE "events"
SET "payload" = ("payload"::jsonb || '{"harness": "agents"}'::jsonb)::json
WHERE "type" = 'thread.started'
  AND "run_id" IN (SELECT "id" FROM "runs" WHERE ("harness" IS NULL OR "harness" = 'tasks') AND "state" = 'ended')
  AND CASE WHEN "type" = 'thread.started' THEN "payload"->>'parentThreadId' END IS NULL;
--> statement-breakpoint
-- A task or check thread is a worker, any other child the main agent; the task fields go.
UPDATE "events"
SET "payload" = (
  ("payload"::jsonb - 'task' - 'attemptId')
  || jsonb_build_object('role', CASE WHEN "payload"->>'task' IS NOT NULL OR "payload"->>'attemptId' IS NOT NULL THEN 'worker' ELSE 'main' END)
)::json
WHERE "type" = 'thread.started'
  AND "run_id" IN (SELECT "id" FROM "runs" WHERE ("harness" IS NULL OR "harness" = 'tasks') AND "state" = 'ended')
  AND CASE WHEN "type" = 'thread.started' THEN "payload"->>'parentThreadId' END IS NOT NULL
  AND CASE WHEN "type" = 'thread.started' THEN "payload"->>'role' END IS NULL;
--> statement-breakpoint
-- Runs pinned to a workflow directory the repo has since renamed read the bundled catalog of its new name.
UPDATE "runs"
SET "workflows" = replace("workflows"::text, 'workflows/workflow-mouse-oa', 'workflows/mouse-oa')::json
WHERE ("harness" IS NULL OR "harness" = 'tasks') AND "state" = 'ended' AND "workflows"::text LIKE '%workflows/workflow-mouse-oa%';
--> statement-breakpoint
UPDATE "runs" SET "harness" = 'agents' WHERE ("harness" IS NULL OR "harness" = 'tasks') AND "state" = 'ended';
`;

const { values } = parseArgs({
  options: {
    staging: { type: "string" },
    from: { type: "string" },
    save: { type: "string" },
    out: { type: "string" },
    report: { type: "string" },
    "skip-r2": { type: "boolean" },
  },
});
if (!values.out || !values.report || !(values.staging || values.from))
  throw new Error(
    "usage: convert:task-runs (--staging <url> | --from <dir>) --out <migration.sql> --report <report.md> [--save <dir>] [--skip-r2]",
  );

interface StoredRun {
  id: string;
  selectedOutputs?: string[];
  workflows: { repo: string; path?: string }[];
  events: RunEvent[];
}

/** The stored events of a run stream: its `data:` frames, less the `event: live` ones. */
function eventsOfStream(text: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const frame of text.split("\n\n")) {
    const lines = frame.split("\n");
    if (lines.some((l) => l.startsWith("event: "))) continue;
    const data = lines.find((l) => l.startsWith("data: "));
    if (data) events.push(JSON.parse(data.slice(6)));
  }
  return events;
}

async function loadRuns(): Promise<StoredRun[]> {
  if (values.from) {
    const dir = values.from;
    const ids = (await readdir(dir))
      .filter((f) => f.endsWith(".run.json"))
      .map((f) => f.slice(0, -9));
    return Promise.all(
      ids.sort().map(async (id) => ({
        ...JSON.parse(await readFile(join(dir, `${id}.run.json`), "utf8")),
        events: (await readFile(join(dir, `${id}.ndjson`), "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      })),
    );
  }
  const base = (values.staging as string).replace(/\/$/, "");
  const token = process.env.VOLUMA_DEBUG_TOKEN;
  if (!token) throw new Error("VOLUMA_DEBUG_TOKEN is not set");
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res;
  };
  const { runs } = (await (await get("/api/run/runs")).json()) as { runs: { id: string }[] };
  const fetched: StoredRun[] = [];
  for (const { id } of runs.map((r) => r).sort((a, b) => a.id.localeCompare(b.id))) {
    const row = (await (await get(`/api/run/runs/${id}`)).json()) as StoredRun;
    const events = eventsOfStream(await (await get(`/api/run/runs/${id}/stream`)).text());
    fetched.push({ id, workflows: row.workflows, selectedOutputs: row.selectedOutputs, events });
  }
  if (values.save) {
    await mkdir(values.save, { recursive: true });
    for (const r of fetched) {
      const { events, ...row } = r;
      await writeFile(join(values.save, `${r.id}.run.json`), JSON.stringify(row));
      await writeFile(
        join(values.save, `${r.id}.ndjson`),
        events.map((e) => JSON.stringify(e)).join("\n"),
      );
    }
  }
  return fetched;
}

/** The bucket's objects under a run's `outputs/` and `evidence/`, to check a version's files against. */
async function fileCheckOf(runId: string): Promise<FileCheck> {
  if (values["skip-r2"]) return () => undefined;
  const { store } = r2FromEnv();
  const listed = async (prefix: string) =>
    new Map<string, ObjectInfo>(
      (await store.list(prefix)).objects.map((o) => [o.key, { size: o.size, etag: o.etag }]),
    );
  const outputs = await listed(outputsPrefix(runId));
  const evidence = await listed(evidencePrefix(runId));
  const single = (etag: string | undefined) =>
    etag !== undefined && !etag.replaceAll('"', "").includes("-");
  return (key, sha256) => {
    const file = outputs.get(key);
    if (!file) return "no object";
    const reported = evidence.get(evidenceKey(runId, sha256));
    if (!reported) return "no evidence object for its sha256";
    if (file.size !== reported.size) return `size ${file.size} against evidence ${reported.size}`;
    if (single(file.etag) && single(reported.etag) && file.etag !== reported.etag)
      return "ETag differs from evidence";
    return undefined;
  };
}

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Applies only to the run (or a copy of its log) exactly as fetched: same event count and same last event, so a run that has moved on, or is not ended, is left unconverted. */
function insertOf(run: StoredRun, events: NewEvent[], allIds: string[]): string {
  const first = run.events.find((e) => e.type === "revision.started");
  const last = run.events.at(-1);
  if (!first || !last || events.length === 0) return "";
  const rows = events
    .map(
      (e, i) =>
        `(${i + 1}, ${quote(e.id)}, ${quote(e.threadId)}, ${quote(e.type)}, ${quote(JSON.stringify(e.payload))}, ${quote(e.createdAt)})`,
    )
    .join(",\n  ");
  return `-- ${run.id}: ${events.length} events
INSERT INTO "events" ("run_id", "id", "thread_id", "seq", "type", "payload", "created_at")
SELECT r."run_id", v."id", v."thread_id", r."last_seq" + v."n", v."type", v."payload"::json, v."created_at"::timestamptz
FROM (
  SELECT e."run_id", (SELECT max(m."seq") FROM "events" m WHERE m."run_id" = e."run_id") AS "last_seq"
  FROM "events" e
  WHERE e."id" = ${quote(first.id)} AND e."type" = 'revision.started'
    AND (e."run_id" = ${quote(run.id)} OR e."run_id" NOT IN (${allIds.map(quote).join(", ")}))
    AND EXISTS (SELECT 1 FROM "runs" x WHERE x."id" = e."run_id" AND x."state" = 'ended')
    AND (SELECT count(*) FROM "events" c WHERE c."run_id" = e."run_id") = ${run.events.length}
    AND (SELECT l."id" || ':' || l."seq" FROM "events" l WHERE l."run_id" = e."run_id" ORDER BY l."seq" DESC LIMIT 1) = ${quote(`${last.id}:${last.seq}`)}
) r
CROSS JOIN (VALUES
  ${rows}
) AS v("n", "id", "thread_id", "type", "payload", "created_at")
ON CONFLICT DO NOTHING;
`;
}

function reportOf(r: RunReport, events: number): string {
  const lines = [
    `## ${r.runId}`,
    "",
    `${events} events before; ${r.selected.length} listed outputs: ${r.published.length} published versions, ${r.missing.length} listed as missing.`,
  ];
  const list = (title: string, items: string[]) =>
    items.length > 0 &&
    lines.push("", `${title} (${items.length}):`, ...items.map((i) => `- ${i}`));
  list(
    "Missing",
    r.missing.map((m) => `${m.id}: ${m.reason}`),
  );
  list(
    "Reported outputs not converted",
    r.dropped.map((d) => `${d.id}: ${d.why}`),
  );
  list(
    "To check items dropped",
    r.droppedChecks.map((d) => `${d.task}: ${d.title} (${d.why})`),
  );
  list("R2 misses", r.r2Misses);
  return lines.join("\n");
}

const catalog = outputCatalogSchema.parse(
  parse(
    await readFile(new URL("../../../../workflows/mouse-oa/outputs.yaml", import.meta.url), "utf8"),
  ),
);
const runs = await loadRuns();
const ids = runs.map((r) => r.id);
const statements: string[] = [];
const reports: string[] = [];
for (const run of runs) {
  const { events, report } = convertRun({
    runId: run.id,
    events: run.events,
    selectedOutputs: run.selectedOutputs,
    catalog,
    check: await fileCheckOf(run.id),
  });
  statements.push(insertOf(run, events, ids));
  reports.push(reportOf(report, run.events.length));
  console.log(`${run.id}: ${report.published.length} published, ${report.missing.length} missing`);
}
await writeFile(
  values.out,
  `-- Step 1 of retiring the task loop: gives every stored task-loop run the agent loop's outputs,\n-- then the tail (see apps/api/src/ops/convert-task-runs.ts). Generated; do not edit.\n${statements.filter(Boolean).join("--> statement-breakpoint\n")}${statements.some(Boolean) ? "--> statement-breakpoint\n" : ""}${MIGRATION_TAIL}`,
);
await writeFile(
  values.report,
  `# Conversion of stored task-loop runs\n\n${reports.join("\n\n")}\n`,
);
