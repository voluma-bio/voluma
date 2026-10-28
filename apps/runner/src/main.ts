/**
 * The runner: runs one Pi agent thread on one task, with `bash` as its only tool, in a
 * Modal sandbox created on the first command. Everything is recorded through the API
 * (events and Pi messages) and printed. Ctrl-C (or SIGTERM, SIGHUP) aborts the running command and ends the
 * thread as cancelled; running again with the same --run and --thread resumes it. A
 * thread that already finished does nothing until given a new message with --input.
 *
 *   pnpm --filter @voluma/runner run-task --provider openai --model gpt-5-mini \
 *     --task "Report the slice count of the scan in /inputs"
 *
 * Reads the repo's .env (see config.ts): model keys, R2 and Modal credentials,
 * VOLUMA_API_URL and VOLUMA_API_TOKEN (unset: the API `pnpm dev` started in this worktree,
 * from .dev/env.json). None of them enter the sandbox or process.env.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { runIdSchema } from "@voluma/contracts/ids";
import { referencePrefix } from "@voluma/contracts/r2";
import { httpClient } from "@voluma/harness/adapters/http";
import { startThread } from "@voluma/harness/adapters/pi";
import { runLayout } from "@voluma/harness/layout";
import { recorder } from "@voluma/harness/recorder";
import { sandboxSession } from "@voluma/harness/sandbox-session";
import { bashTool } from "@voluma/harness/tools/bash";
import { localApi, optional, required } from "./config.ts";
import { createModalSandbox, RUNS_APP, terminateRun } from "./modal-sandbox.ts";

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    task: { type: "string" },
    input: { type: "string" },
    run: { type: "string" },
    thread: { type: "string" },
  },
});
const { provider, model: modelId, task } = values;
if (!provider || !modelId || !task) {
  throw new Error(
    "usage: main.ts --provider openai|anthropic|meta --model <id> --task <text> [--run <id>] [--thread <id>] [--input <text>]",
  );
}
const runId = runIdSchema.parse(values.run ?? `run-${randomUUID().slice(0, 8)}`);
const threadId = values.thread ?? `${runId}.main`;
if (!threadId.startsWith(`${runId}.`)) throw new Error(`--thread must begin with "${runId}."`);

const models = createModels();
const providers = { anthropic: anthropicProvider, meta: metaProvider, openai: openaiProvider };
if (!(provider in providers)) throw new Error(`unknown provider ${provider}`);
models.setProvider(providers[provider as keyof typeof providers]());
const apiKey = required(`VOLUMA_${provider.toUpperCase()}_API_KEY`);
const model = models.getModel(provider, modelId);
if (!model) throw new Error(`unknown model ${provider}/${modelId}`);

const apiUrl = optional("VOLUMA_API_URL");
// Every ingest write carries the lease of a claimed run (`@voluma/contracts/runner`). This CLI
// should claim a queued run and take the token from the claim; until the API serves claims
// (lane A) and the claimer exists (lane E), the token is passed in. Today's API checks no token,
// so any value works.
const api = httpClient({
  ...(apiUrl ? { baseUrl: apiUrl, token: required("VOLUMA_API_TOKEN") } : localApi()),
  runId,
  leaseToken: required("VOLUMA_LEASE_TOKEN"),
});
const layout = runLayout(runId, referencePrefix("scan"));
const systemPrompt = `You are an analysis agent with one tool, bash, which runs commands in a sandbox.
Python 3.12 with numpy, scipy, scikit-image, pydicom, nibabel and SimpleITK is installed.
Check what you report against the files themselves, and say which file or header each number came from.`;
const abort = new AbortController();
const events = recorder(
  {
    async append(event) {
      await api.append(event);
      printEvent(event);
    },
  },
  runId,
  () => abort.abort(),
);

const modalTokenId = optional("MODAL_TOKEN_ID");
const modalTokenSecret = optional("MODAL_TOKEN_SECRET");
const modal =
  modalTokenId && modalTokenSecret
    ? { tokenId: modalTokenId, tokenSecret: modalTokenSecret }
    : undefined;
const lifetimeSeconds = Number(optional("VOLUMA_SANDBOX_LIFETIME_SECONDS") ?? 3600);
if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds <= 0) {
  throw new Error("VOLUMA_SANDBOX_LIFETIME_SECONDS must be a positive integer");
}
// The floor keeps a sandbox from idling out before its inputs finish staging.
const idleSeconds = Number(optional("VOLUMA_SANDBOX_IDLE_SECONDS") ?? 300);
if (!Number.isInteger(idleSeconds) || idleSeconds < 30) {
  throw new Error("VOLUMA_SANDBOX_IDLE_SECONDS must be an integer of at least 30");
}
const createSandbox = createModalSandbox({
  appName: RUNS_APP,
  modal,
  r2: {
    accountId: required("R2_ACCOUNT_ID"),
    bucket: required("R2_BUCKET"),
    parentAccessKeyId: required("R2_ACCESS_KEY_ID"),
    cloudflareApiToken: required("CLOUDFLARE_API_TOKEN"),
  },
});
const session = sandboxSession(
  () =>
    createSandbox({
      runId,
      name: "main",
      image: optional("VOLUMA_SANDBOX_IMAGE") ?? "voluma-microct",
      cpu: 2,
      memoryMiB: 4096,
      lifetimeSeconds,
      idleSeconds,
      mounts: layout.mounts,
    }),
  (id, state, detail) => events.emit(id, "sandbox", { name: "main", state, detail }),
  layout.restartNote,
);

// First SIGINT/SIGTERM/SIGHUP stops the running command; the `finally` below then closes the
// sandbox. A second one closes it now, bounded, and exits. Closing the sandbox waits for any
// creation in flight, so the second signal also terminates the run's sandboxes by tag.
const FORCE_CLOSE_MS = 5000;
// After a hangup the terminal is gone and any write throws EIO, which would end the process
// before it cleans up.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(name, () => {
    if (abort.signal.aborted) {
      console.error(`\n${name}: closing the sandbox and quitting`);
      void Promise.race([
        Promise.allSettled([session.close(), terminateRun(modal, runId)]),
        new Promise((done) => setTimeout(done, FORCE_CLOSE_MS)),
      ])
        .catch(() => {})
        .finally(() => process.exit(130));
      return;
    }
    console.error(`\n${name}: stopping the running command (signal again to quit now)`);
    abort.abort();
  });
}

console.log(`run ${runId}  thread ${threadId}  model ${provider}/${modelId}`);
try {
  const outcome = await startThread({
    runId,
    threadId,
    kind: "worker",
    taskId: "cli",
    model,
    // The key goes with each request; pi-ai is never left to look in process.env.
    streamFn: (m, context, options) => models.streamSimple(m, context, { ...options, apiKey }),
    systemPrompt,
    prompt: task,
    input: values.input ? { text: values.input, sender: { kind: "person" } } : undefined,
    tools: [bashTool(layout)],
    recorder: events,
    history: api,
    sandbox: (id) => session.get(id),
    signal: abort.signal,
  }).done;
  const u = outcome.usage;
  if (!outcome.ran && outcome.status === "completed") {
    console.log("this thread already finished; pass --input <text> to continue it");
  }
  console.log(
    `\n${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}\n` +
      `model usage this invocation: ${u.input} in, ${u.cacheRead} cache read, ${u.cacheWrite} cache write, ` +
      `${u.output} out, $${u.cost.toFixed(4)}`,
  );
  process.exitCode = outcome.status === "completed" ? 0 : 1;
} finally {
  try {
    await session.close();
  } finally {
    await events.flush();
  }
}

function printEvent(event: Parameters<typeof api.append>[0]): void {
  const p = event.payload as Record<string, unknown>;
  const clip = (value: unknown) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  };
  switch (event.type) {
    case "message":
      console.log(`[${p.role}] ${clip(p.text)}`);
      break;
    case "tool.call":
      console.log(`[call ${p.toolCallId}] ${clip(p.input)}`);
      break;
    case "tool.result":
      console.log(`[result ${p.toolCallId}${p.truncated ? " truncated" : ""}] ${clip(p.output)}`);
      break;
    default:
      console.log(`[${event.type}] ${clip(p)}`);
  }
}
