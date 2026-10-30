/**
 * The agent test loop's last step: start a run on the local API (`pnpm dev`), wait for it to
 * end, and print what it produced.
 *   pnpm --filter @voluma/runner try-run [--scan <inputId>] [--workflow <id>]
 *       [--outputs <id,id>] [--notes <text>]
 * A runner must be running (`pnpm --filter @voluma/runner start`) to claim the run. It signs in
 * with the WORKOS_TEST_EMAIL and WORKOS_TEST_PASSWORD of the repo .env, as `upload:scan` does,
 * on the API and origin `.dev/env.json` names; the scan defaults to the lab's reference scan.
 * It waits on the run's event stream, not a timer, and prints a line per task change, tool
 * call and thread. Exit 0 when the run completed, 1 when it failed or was cancelled, 2 when the
 * script itself broke (no `pnpm dev`, sign-in or API errors, the stream lost for good), 3 when no
 * runner claimed the run within CLAIM_WAIT_MS.
 */
import { parseArgs } from "node:util";
import { meResponseSchema } from "@voluma/contracts/auth";
import { type RunEvent, runEventSchema } from "@voluma/contracts/events";
import { fold } from "@voluma/contracts/fold";
import { listInputsResponseSchema, runSchema } from "@voluma/contracts/run";
import { spend } from "@voluma/contracts/spend";
import { END_EVENT } from "@voluma/contracts/stream";
import { studyDetailSchema } from "@voluma/contracts/study";
import { workflowById } from "@voluma/workflow/bundled";
import { devEnv, required } from "./config.ts";

const CLAIM_WAIT_MS = 3 * 60_000;
const RECONNECT_MS = 2000;
// Long enough to ride out the API's `tsx --watch` restart after an edit.
const MAX_STREAM_FAILURES = 30;

// A throw anywhere is the script's own failure, not a failed run.
process.on("uncaughtException", (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    scan: { type: "string" },
    workflow: { type: "string", default: "mouse-oa" },
    outputs: { type: "string" },
    notes: { type: "string" },
  },
});
const workflow = workflowById(values.workflow);
if (!workflow) fail(`unknown workflow ${values.workflow}`);

const dev = devEnv() ?? fail("no .dev/env.json: run `pnpm dev` first");
const origin = dev.appUrl;
const say = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

/** The session cookie, kept current from every response (the API rotates it). */
const jar = new Map<string, string>();
async function api(path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${dev.apiUrl}/api${path}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers: {
      // The API's CSRF rules apply to a script's cookie requests too.
      origin,
      "content-type": "application/json",
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res;
}

await api("/auth/password", {
  body: { email: required("WORKOS_TEST_EMAIL"), password: required("WORKOS_TEST_PASSWORD") },
});
const me = meResponseSchema.parse(await (await api("/auth/me")).json());
say(`signed in to ${dev.apiUrl} as ${me.kind === "member" ? me.email : me.userId}`);

const { inputs } = listInputsResponseSchema.parse(await (await api("/run/inputs")).json());
const input = values.scan
  ? inputs.find((i) => i.id === values.scan)
  : inputs.find((i) => i.source === "reference");
if (!input) {
  const have = inputs.map((i) => `${i.id} (${i.name})`).join(", ");
  throw new Error(
    `no such scan ${values.scan ?? "(the reference scan)"}; this user can see: ${have}`,
  );
}

const outputs = values.outputs?.split(",").map((s) => s.trim());
const study = studyDetailSchema.parse(
  await (
    await api("/run/studies", {
      body: {
        name: `try-run ${new Date().toISOString().slice(0, 16)}`,
        workflowId: workflow.id,
        scans: [{ inputId: input.id }],
        start: [input.id],
        ...(outputs && { selectedOutputs: outputs }),
        ...(values.notes && { notes: values.notes }),
      },
    })
  ).json(),
);
const runId = study.scans.flatMap((s) => s.runs).at(0)?.id;
if (!runId) throw new Error("the study started no run");
say(`started run ${runId} on ${input.name} (${workflow.id}); waiting for a runner to claim it`);
say("(none running? start one: pnpm --filter @voluma/runner start)");
const unclaimed = setTimeout(() => {
  say(
    `not claimed: no runner took the run in ${CLAIM_WAIT_MS / 60_000} min. Start one on this worktree (pnpm --filter @voluma/runner start), then try-run again; the run is left queued.`,
  );
  process.exit(3);
}, CLAIM_WAIT_MS);

const events: RunEvent[] = [];
const progress = (e: RunEvent) => {
  if (e.type === "task") say(`task ${e.payload.taskId}: ${e.payload.status} - ${e.payload.reason}`);
  else if (e.type === "tool.call") say(`  tool ${e.payload.name}`);
  else if (e.type === "thread.started")
    say(`thread started: ${e.payload.kind} ${e.payload.task ?? ""}`);
  else if (e.type === "thread.ended") say("thread ended");
  else if (e.type === "claim.started") {
    clearTimeout(unclaimed);
    say("runner claimed the run");
  }
};

// The stream sends `id: seq`, replays from `Last-Event-ID`, and says `event: end` once the run
// has ended and its log is sent. A dropped connection resumes from the last seq.
let lastSeq = "";
for (let ended = false, failures = 0; !ended; ) {
  try {
    const res = await api(`/run/runs/${runId}/stream`, {
      headers: { accept: "text/event-stream", ...(lastSeq && { "last-event-id": lastSeq }) },
    });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
        const message = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const field = (name: string) =>
          message
            .split("\n")
            .filter((l) => l.startsWith(`${name}:`))
            .map((l) => l.slice(name.length + 1).trimStart())
            .join("\n");
        const name = field("event");
        if (name === END_EVENT) ended = true;
        else if (name === "" && field("data")) {
          const event = runEventSchema.parse(JSON.parse(field("data")));
          lastSeq = field("id");
          events.push(event);
          progress(event);
        }
      }
    }
    failures = 0;
    // The API closes streams cleanly when it shuts down; pause so a repeat is not a tight loop.
    if (!ended) await new Promise((r) => setTimeout(r, RECONNECT_MS));
  } catch (error) {
    if (++failures > MAX_STREAM_FAILURES) throw error;
    say(`stream dropped (${error instanceof Error ? error.message : error}); resuming`);
    await new Promise((r) => setTimeout(r, RECONNECT_MS));
  }
}

const run = runSchema.parse(await (await api(`/run/runs/${runId}`)).json());
const folded = fold(events);
console.log(
  `\nrun ${runId}: ${run.state.status === "ended" ? run.state.outcome : run.state.status}`,
);
if (run.state.status === "ended" && run.state.error) console.log(`error: ${run.state.error}`);
for (const t of folded.tasks) {
  if (t.status === "pending") {
    console.log(`\n${t.id}: not started`);
    continue;
  }
  const reported = [...t.measurements, ...t.scores].map((o) => o.id);
  if (t.files.length) reported.push(`${t.files.length} file(s)`);
  console.log(`\n${t.id}: ${t.status}${t.reason ? ` - ${t.reason}` : ""}`);
  console.log(`  reported: ${reported.join(", ") || "none"}`);
  console.log(
    `  missing: ${t.missing.map((m) => `${m.outputId}${m.required ? " (required)" : ""}`).join(", ") || "none"}`,
  );
}
const total = spend(events, run.providerCalls).total;
console.log(
  `\ncost: $${total.costUsd.toFixed(2)} (${total.calls} model calls` +
    `${run.providerCalls ? `, ${run.providerCalls.calls} gateway calls $${run.providerCalls.costUsd.toFixed(2)}` : ""})`,
);
console.log(`page: ${origin}/scans/${runId}`);
process.exit(run.state.status === "ended" && run.state.outcome === "completed" ? 0 : 1);
