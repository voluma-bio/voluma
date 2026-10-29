/**
 * Drives a run's real sandbox, tools and gateway without a model, to try `voluma-sam` or a new
 * image by hand:
 *
 *   pnpm --filter @voluma/runner dev-sandbox --run <id> [--role worker] [--allow-remote]
 *
 * Start a run in the web app first (`pnpm dev`): this claims the next queued run (it must be
 * the one named by `--run`, else it is given back) and holds its
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
 * Needs the runner's `.env` (`config.ts`), including `VOLUMA_GATEWAY_URL`. It refuses an API that
 * is not on this machine unless `--allow-remote` is given: it ends the run it claims as failed.
 */
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { claimRun } from "@voluma/harness/adapters/http/hand-off";
import { runClient } from "@voluma/harness/adapters/http/run-client";
import type { Sandbox } from "@voluma/harness/ports/sandbox";
import { workerSandboxSpec } from "@voluma/harness/sandbox-specs";
import { segmentSamTool } from "@voluma/harness/tools/segment-sam";
import { runnerConfig } from "./config.ts";
import { holdLease } from "./lease.ts";
import { claimSandboxes, terminateClaim } from "./modal-sandbox.ts";
import { redactor } from "./redact.ts";
import { layoutOf } from "./run.ts";
import { sandboxGateway } from "./sandbox-gateway.ts";
import { usageMeter } from "./usage.ts";

const { values } = parseArgs({
  options: {
    role: { type: "string", default: "worker" },
    run: { type: "string" },
    "allow-remote": { type: "boolean", default: false },
  },
});
if (values.role !== "worker") throw new Error("only --role worker exists so far");
if (!values.run) throw new Error("pass --run <id>: the run this script may claim and end");

const config = runnerConfig();
const redact = redactor(config.secrets);
const log = (line: string) => console.log(`${new Date().toISOString()} ${redact(line)}`);
if (!config.gateway)
  throw new Error(
    "set VOLUMA_GATEWAY_URL and GATEWAY_TOKEN_SECRET: sandboxes reach providers only through the gateway",
  );
const apiHost = new URL(config.api.baseUrl).hostname;
if (!["localhost", "127.0.0.1", "[::1]"].includes(apiHost) && !values["allow-remote"])
  throw new Error(`${apiHost} is not this machine: pass --allow-remote to claim a run there`);

const claim = await claimRun(config.api, "dev-sandbox", config.maxRunCostUsd);
if (!claim) throw new Error("no queued run: start one in the web app (pnpm dev) first");
const { run, leaseToken } = claim;
if (run.id !== values.run) {
  // Not ours: hand it back to the queue.
  await runClient(config.api, { runId: run.id, leaseToken }, { redact, onLeaseLost: () => {} })
    .report({ kind: "released", reason: "shutdown" })
    .catch(() => {});
  throw new Error(`claimed run ${run.id}, not ${values.run}; gave it back`);
}
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
  client,
  onRoundTrip: (ms) => {
    beats.count++;
    beats.maxRoundTripMs = Math.max(beats.maxRoundTripMs, ms);
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

let sandbox: Sandbox | undefined;
let counted = false;
const rl = createInterface({ input: process.stdin });

/** Once: the `close` command, end of input, a signal, a lost lease and a crash all arrive here. */
let closing: Promise<void> | undefined;
const close = () =>
  // biome-ignore lint/suspicious/noAssignInExpressions: once-guard
  (closing ??= (async () => {
    log("closing");
    rl.close();
    await lease.end(true).catch(() => {});
    await sandbox?.destroy().catch((e) => log(`destroy failed: ${e}`));
    await terminateClaim(modal, run.id, claimId).catch((e) => log(`terminate failed: ${e}`));
    if (counted) meter.sandboxDown();
    await client
      .report({ kind: "ended", outcome: "failed", error: "closed by dev-sandbox" })
      .catch((e) => log(`report failed: ${e}`));
    loop.disable();
  })());
const closeAndExit = () => void close().then(() => process.exit(0));
abort.signal.addEventListener("abort", closeAndExit);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, closeAndExit);

let exitCode = 0;
try {
  const thread = layoutOf(run, []).forThread(`${run.id}.dev.worker`); // no workflow is loaded here, so no PYTHONPATH
  meter.sandboxUp();
  counted = true;
  sandbox = await claimSandboxes(
    config,
    modal,
    claimId,
  )(
    workerSandboxSpec({
      runId: run.id,
      name: thread.name,
      image: config.sandbox.image,
      lifetimeSeconds: config.sandbox.lifetimeSeconds,
      idleSeconds: config.sandbox.idleSeconds,
      mounts: thread.mounts,
      env: thread.env,
      workdir: thread.dir,
      gateway: sandboxGateway(
        config,
        { runId: run.id, leaseToken, visitorMetaKey: claim.keys?.metaApiKey },
        thread.name,
        redact,
      ),
    }),
    abort.signal,
  );
  log(`sandbox ${thread.name} ready; commands: exec <cmd> | segment <json> | close`);

  const tool = segmentSamTool(thread);
  const context = {
    runId: run.id,
    threadId: `${run.id}.${thread.name}`,
    kind: "worker" as const,
    toolCallId: "dev",
    signal: abort.signal,
    sandbox: async () => sandbox as Sandbox,
    output: (_stream: "stdout" | "stderr", text: string) => process.stderr.write(text),
  };

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
        break;
      } else if (rest.length || command) {
        console.log("exec <cmd> | segment <json> | close");
      }
    } catch (error) {
      console.log(`error: ${error}`);
    }
    console.log(stats());
  }
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await close();
  process.exit(exitCode);
}
