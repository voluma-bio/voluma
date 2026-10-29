/**
 * Drives a run's real sandbox, tools and gateway without a model, to try `voluma-sam` or a new
 * image by hand:
 *
 *   pnpm --filter @voluma/runner dev-sandbox [--role worker]
 *
 * Start a run in the web app first (`pnpm dev`): this claims the next queued run, holds its
 * lease with the real heartbeat (so a runner never takes it and the API sees it live), opens
 * the role's sandbox through the real adapter with a gateway token minted for it, and reads
 * commands from stdin:
 *
 *   exec <shell command>   run it in the sandbox, as `bash` does
 *   segment <json>         run the real `segment_sam` tool on the input (see its schema)
 *   close                  terminate the claim's sandboxes by tag and end the run
 *
 * Calls are metered like a run's: sandbox seconds go out with the heartbeat, and the gateway
 * counts provider calls against the run's cap. After each command it prints the event-loop
 * delay and heartbeat timing of this process. Only the worker role exists so far.
 * Needs the runner's `.env` (`config.ts`), including `VOLUMA_GATEWAY_URL`.
 */
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { claimRun } from "@voluma/harness/adapters/http/hand-off";
import { runClient } from "@voluma/harness/adapters/http/run-client";
import { workerSandboxSpec } from "@voluma/harness/sandbox-specs";
import { segmentSamTool } from "@voluma/harness/tools/segment-sam";
import { runnerConfig } from "./config.ts";
import { holdLease } from "./lease.ts";
import { claimSandboxes, terminateClaim } from "./modal-sandbox.ts";
import { redactor } from "./redact.ts";
import { layoutOf } from "./run.ts";
import { sandboxGateway } from "./sandbox-gateway.ts";
import { usageMeter } from "./usage.ts";

const { values } = parseArgs({ options: { role: { type: "string", default: "worker" } } });
if (values.role !== "worker") throw new Error("only --role worker exists so far");

const config = runnerConfig();
const redact = redactor(config.secrets);
const log = (line: string) => console.log(`${new Date().toISOString()} ${redact(line)}`);
if (!config.gateway)
  throw new Error(
    "set VOLUMA_GATEWAY_URL and GATEWAY_TOKEN_SECRET: sandboxes reach providers only through the gateway",
  );

const claim = await claimRun(config.api, "dev-sandbox", config.maxRunCostUsd);
if (!claim) throw new Error("no queued run: start one in the web app (pnpm dev) first");
const { run, leaseToken } = claim;
const claimId = randomUUID();
const modal = claim.keys?.modal ?? config.modal;
log(`claimed run ${run.id}`);

const abort = new AbortController();
const client = runClient(
  config.api,
  { runId: run.id, leaseToken },
  { redact, onLeaseLost: () => abort.abort() },
);
const meter = usageMeter();
const beats = { count: 0, maxRoundTripMs: 0 };
const lease = holdLease({
  onSpent: (usd) => log(`run spend $${usd.toFixed(4)}`),
  client: {
    async heartbeat(usage) {
      const start = performance.now();
      try {
        return await client.heartbeat(usage);
      } finally {
        beats.count++;
        beats.maxRoundTripMs = Math.max(beats.maxRoundTripMs, performance.now() - start);
      }
    },
  },
  meter,
  onStop: (reason) => {
    log(`the run stopped (${reason})`);
    abort.abort();
  },
  log,
});
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const stats = () => {
  const line = `event loop: max ${(loop.max / 1e6).toFixed(0)} ms, p99 ${(loop.percentile(99) / 1e6).toFixed(0)} ms; heartbeats: ${beats.count}, slowest round trip ${beats.maxRoundTripMs.toFixed(0)} ms`;
  loop.reset();
  return line;
};

const layout = layoutOf(run, []); // no workflow is loaded here, so no PYTHONPATH
const sandboxName = "dev.worker";
meter.sandboxUp();
const sandbox = await claimSandboxes(
  config,
  modal,
  claimId,
)(
  workerSandboxSpec({
    runId: run.id,
    name: sandboxName,
    image: config.sandbox.image,
    lifetimeSeconds: config.sandbox.lifetimeSeconds,
    idleSeconds: config.sandbox.idleSeconds,
    mounts: layout.mounts,
    env: layout.env,
    gateway: sandboxGateway(
      config,
      { runId: run.id, leaseToken, visitorMetaKey: claim.keys?.metaApiKey },
      sandboxName,
      redact,
    ),
  }),
  abort.signal,
);
log(`sandbox ${sandboxName} ready; commands: exec <cmd> | segment <json> | close`);

const tool = segmentSamTool(layout);
const context = {
  runId: run.id,
  threadId: `${run.id}.${sandboxName}`,
  kind: "worker" as const,
  toolCallId: "dev",
  signal: abort.signal,
  sandbox: async () => sandbox,
  output: (_stream: "stdout" | "stderr", text: string) => process.stderr.write(text),
};

async function close() {
  log("closing");
  rl.close();
  await lease.end(true).catch(() => {});
  await sandbox.destroy().catch((e) => log(`destroy failed: ${e}`));
  await terminateClaim(modal, run.id, claimId).catch((e) => log(`terminate failed: ${e}`));
  meter.sandboxDown();
  await client
    .report({ kind: "ended", outcome: "failed", error: "closed by dev-sandbox" })
    .catch((e) => log(`report failed: ${e}`));
  loop.disable();
  process.exit(0);
}
abort.signal.addEventListener("abort", () => void close());
process.on("SIGINT", () => void close());

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const [command, ...rest] = line.trim().split(/\s+/);
  const argument = line
    .trim()
    .slice((command ?? "").length)
    .trim();
  try {
    if (command === "exec") {
      for await (const chunk of sandbox.exec(
        { command: argument, timeoutSeconds: 1800 },
        abort.signal,
      )) {
        if (chunk.type === "exit") console.log(`[exit code ${chunk.code}]`);
        else (chunk.type === "stdout" ? process.stdout : process.stderr).write(chunk.data);
      }
    } else if (command === "segment") {
      const input = tool.input.parse(JSON.parse(argument));
      console.log(JSON.stringify(await tool.execute(input, context), null, 2));
    } else if (command === "close") {
      await close();
    } else if (rest.length || command) {
      console.log("exec <cmd> | segment <json> | close");
    }
  } catch (error) {
    console.log(`error: ${error}`);
  }
  console.log(stats());
}
await close();
