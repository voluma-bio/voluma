/**
 * Read-only prompt-cache miss watcher for one run, for watching a long run live. It reads the
 * run's stored events from the API's run stream (`GET /api/run/runs/:id/stream`, debug token)
 * and judges every model call with `cacheStep`, the rule the run page uses, then reports misses
 * per thread. A miss is expected when it is the call right after a "Tools changed" notice in its
 * own thread; every other miss is unexpected and is printed with what surrounds it. A
 * compaction summary resets the thread's baseline, as in `spend`. Writes nothing anywhere.
 *
 *   pnpm --filter @voluma/runner cache-watch --run <id> [--watch <minutes>] [--every <seconds>]
 *
 * `VOLUMA_DEBUG_TOKEN` comes from the environment or the repo `.env`; `--url` defaults
 * to staging. The flag line fires when a thread has 2 or more unexpected misses in its last 10
 * calls, or the run-wide unexpected rate is over 1% once the run has made 200 calls.
 */
import { parseArgs } from "node:util";
import { type RunEvent, runEventSchema } from "@voluma/contracts/events";
import { type CacheState, cacheStep } from "@voluma/contracts/spend";

const { values } = parseArgs({
  options: {
    run: { type: "string" },
    watch: { type: "string" },
    every: { type: "string", default: "30" },
    url: { type: "string", default: "https://voluma-api.onrender.com" },
  },
});
if (!values.run)
  throw new Error("usage: cache-watch --run <id> [--watch <minutes>] [--every <seconds>]");
const runId = values.run;
const token = process.env.VOLUMA_DEBUG_TOKEN;
if (!token) throw new Error("VOLUMA_DEBUG_TOKEN is not set");
const base = values.url;

// Jimmy's flag line for the dress rehearsal: 2 unexpected misses in a thread's last 10 calls,
// or a run-wide unexpected rate over 1% once the run has made 200 calls.
const WINDOW = 10;
const THREAD_LIMIT = 2;
const RATE_LIMIT = 0.01;
const RATE_MIN_CALLS = 200;

type Call = { at: number; prompt: number; seq: number };
type Thread = {
  cache?: CacheState;
  prev?: Call;
  calls: number;
  misses: number;
  unexpected: number;
  /** Whether each call was an unexpected miss, newest last. */
  recent: boolean[];
  toolsChangedSince?: number;
  lastResult?: { name: string; output: string; at: number };
};

const threads = new Map<string, Thread>();
const toolName = new Map<string, string>();
// Run-level markers a miss may sit across: restarts, reopens, tool declarations.
const markers: { at: number; what: string }[] = [];
let cursor = 0;
let skipped = 0;
let startMs: number | undefined;
let lastMs = 0;
let calls = 0;
let unexpected = 0;
let misses = 0;
let finished = false;

const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m${String(s % 60).padStart(2, "0")}s`;
};
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");

function ingest(e: RunEvent, out: string[]) {
  const at = Date.parse(e.createdAt);
  startMs ??= at;
  lastMs = Math.max(lastMs, at);
  const t = () => {
    const found = threads.get(e.threadId);
    if (found) return found;
    const th: Thread = { calls: 0, misses: 0, unexpected: 0, recent: [] };
    threads.set(e.threadId, th);
    return th;
  };
  switch (e.type) {
    case "claim.started":
      markers.push({
        at,
        what: `claim.started (resumed=${e.payload.resumed}, after=${e.payload.after ?? "-"})`,
      });
      break;
    case "run.reopened":
      markers.push({ at, what: "run.reopened" });
      break;
    case "tool.call":
      toolName.set(e.payload.toolCallId, e.payload.name);
      break;
    case "tool.result":
      t().lastResult = {
        name: toolName.get(e.payload.toolCallId) ?? "?",
        output: e.payload.output,
        at,
      };
      break;
    case "message": {
      const m = e.payload;
      const th = t();
      if (m.role === "system" && m.text.startsWith("Tools changed")) {
        th.toolsChangedSince = at;
        markers.push({ at, what: `${e.threadId}: ${clip(m.text, 80)}` });
      }
      if (m.role !== "assistant" || !m.usage) break;
      if (m.compaction) {
        th.cache = undefined;
        th.prev = undefined;
        th.toolsChangedSince = undefined;
        break;
      }
      const u = m.usage;
      const prompt = u.input + u.cacheRead + u.cacheWrite;
      const step = cacheStep(th.cache, u);
      th.cache = step.next;
      if (prompt === 0) break; // unreported, not a call
      const prev = th.prev;
      const expected = step.miss && th.toolsChangedSince !== undefined;
      th.calls++;
      calls++;
      th.recent.push(step.miss && !expected);
      if (th.recent.length > WINDOW) th.recent.shift();
      if (step.miss) {
        th.misses++;
        misses++;
      }
      if (step.miss && !expected && prev) {
        th.unexpected++;
        unexpected++;
        const between = markers.filter((x) => x.at > prev.at && x.at <= at).map((x) => x.what);
        const r = th.lastResult;
        const result = r
          ? `${r.name} result ${r.output.length} chars${r.name === "view_image" ? ` [${clip(r.output, 200)}]` : ""}, ${((at - r.at) / 1000).toFixed(0)}s before this call`
          : "none";
        out.push(
          [
            `MISS  ${e.threadId}  seq ${e.seq}  ${e.createdAt}  (+${mmss(at - (startMs ?? at))})`,
            `      prompt ${prompt}  cacheRead ${u.cacheRead}  cacheWrite ${u.cacheWrite}  input ${u.input}  | previous prompt ${prev.prompt}`,
            `      since previous call ${((at - prev.at) / 1000).toFixed(0)}s  | tool result before: ${result}`,
            `      between the two calls: ${between.length ? between.join("; ") : "no claim.started / tools-changed notice"}`,
          ].join("\n"),
        );
      }
      th.prev = { at, prompt, seq: e.seq };
      th.toolsChangedSince = undefined;
      break;
    }
  }
}

/**
 * Reads events after the cursor. The stream stays open on a live run and sends `event: live`
 * frames constantly, so stop at `end` or 4 s after the last stored event, not the last byte.
 */
async function fetchEvents(): Promise<RunEvent[]> {
  const ctl = new AbortController();
  let quiet: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => ctl.abort(), 4000);
  };
  arm();
  const res = await fetch(`${base}/api/run/runs/${runId}/stream?after=${cursor}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    signal: ctl.signal,
  });
  if (!res.ok) throw new Error(`stream ${res.status}`);
  const found: RunEvent[] = [];
  let buf = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const name = /^event: (.*)$/m.exec(frame)?.[1];
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (name === "end") finished = true;
        else if (!name && data) {
          arm();
          const parsed = runEventSchema.safeParse(JSON.parse(data));
          if (parsed.success) found.push(parsed.data);
          else skipped++;
          cursor = Math.max(cursor, (JSON.parse(data) as { seq: number }).seq);
        }
      }
    }
  } catch (error) {
    if (!ctl.signal.aborted) throw error;
  } finally {
    clearTimeout(quiet);
  }
  return found;
}

function summary(): string[] {
  const lines = [
    `run ${runId}  ${finished ? "ended" : "live"}  elapsed ${mmss(lastMs - (startMs ?? lastMs))}  events through seq ${cursor}${skipped ? `  (${skipped} unparsed)` : ""}`,
    `run-wide: ${calls} calls, ${misses} misses, ${unexpected} unexpected, unexpected rate ${calls ? ((100 * unexpected) / calls).toFixed(1) : "0.0"}%`,
    `${"thread".padEnd(34)}calls  misses  unexpected  unexpected-in-last-10`,
  ];
  for (const [id, th] of threads) {
    if (th.calls === 0) continue;
    lines.push(
      `${id.padEnd(34)}${String(th.calls).padStart(5)}${String(th.misses).padStart(8)}${String(th.unexpected).padStart(12)}${String(th.recent.filter(Boolean).length).padStart(23)}`,
    );
  }
  const hot = [...threads].filter(([, th]) => th.recent.filter(Boolean).length >= THREAD_LIMIT);
  for (const [id, th] of hot) {
    lines.push(
      `FLAG  thread ${id} has ${th.recent.filter(Boolean).length} unexpected misses in its last ${WINDOW} calls: consider cancelling`,
    );
  }
  if (calls >= RATE_MIN_CALLS && unexpected / calls > RATE_LIMIT) {
    lines.push(
      `FLAG  run-wide unexpected rate ${((100 * unexpected) / calls).toFixed(1)}% over ${calls} calls: consider cancelling`,
    );
  }
  return lines;
}

async function poll() {
  const out: string[] = [];
  for (const e of await fetchEvents()) ingest(e, out);
  console.log(`\n[${new Date().toISOString()}]`);
  for (const l of out) console.log(l);
  for (const l of summary()) console.log(l);
}

await poll();
if (values.watch) {
  const until = Date.now() + Number(values.watch) * 60_000;
  while (!finished && Date.now() < until) {
    await new Promise((r) => setTimeout(r, Number(values.every) * 1000));
    await poll();
  }
}
