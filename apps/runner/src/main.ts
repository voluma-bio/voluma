/**
 * The runner: runs one Pi agent thread on one task, with `bash` as its only tool, in a
 * Modal sandbox created on the first command. Everything is recorded through the API
 * (events and Pi messages) and printed. Ctrl-C aborts the running command and ends the
 * thread as cancelled; running again with the same --run and --thread resumes it.
 *
 *   pnpm --filter @voluma/runner run-task --provider openai --model gpt-5-mini \
 *     --task "Report the slice count of the scan in /inputs"
 *
 * Reads ~/gitrepos/voluma/.env through `--env-file`: model keys, R2 and Modal
 * credentials, VOLUMA_API_URL and VOLUMA_API_TOKEN. None of them enter the sandbox.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { outputsPrefix, referencePrefix, scratchPrefix } from "@voluma/contracts/r2";
import { httpClient } from "@voluma/harness/adapters/http";
import { runThread } from "@voluma/harness/adapters/pi";
import { sandboxSession } from "@voluma/harness/sandbox-session";
import { bashTool } from "@voluma/harness/tools/bash";
import { createModalSandbox } from "./modal-sandbox.ts";

const SYSTEM_PROMPT = `You are an analysis agent with one tool, bash, which runs commands in a sandbox.
Python 3.12 with numpy, scipy, scikit-image, pydicom, nibabel and SimpleITK is installed. There is no network.
- /inputs is read-only: the input data.
- /outputs is for files you produce; they are kept.
- /scratch is for temporary files.
Check what you report against the files themselves, and say which file or header each number came from.`;

const RESUME_PROMPT = "The run was interrupted. Continue the task from where you stopped.";

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    task: { type: "string" },
    run: { type: "string" },
    thread: { type: "string" },
  },
});
const { provider, model: modelId, task } = values;
if (!provider || !modelId || !task) {
  throw new Error(
    "usage: main.ts --provider openai|anthropic --model <id> --task <text> [--run <id>] [--thread <id>]",
  );
}
const runId = values.run ?? `run-${randomUUID().slice(0, 8)}`;
const threadId = values.thread ?? `${runId}.main`;

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const models = createModels();
models.setProvider(provider === "anthropic" ? anthropicProvider() : openaiProvider());
const model = models.getModel(provider, modelId);
if (!model) throw new Error(`unknown model ${provider}/${modelId}`);

const api = httpClient({ baseUrl: env("VOLUMA_API_URL"), token: env("VOLUMA_API_TOKEN") });
const eventLog = {
  async append(event: Parameters<typeof api.append>[0]) {
    await api.append(event);
    printEvent(event);
  },
};

const createSandbox = createModalSandbox({
  appName: "voluma-runs",
  r2: {
    accountId: env("R2_ACCOUNT_ID"),
    bucket: env("R2_BUCKET"),
    parentAccessKeyId: env("R2_ACCESS_KEY_ID"),
    cloudflareApiToken: env("CLOUDFLARE_API_TOKEN"),
  },
});
const sandbox = sandboxSession(
  () =>
    createSandbox({
      runId,
      name: "main",
      image: process.env.VOLUMA_SANDBOX_IMAGE ?? "voluma-microct",
      cpu: 2,
      memoryMiB: 4096,
      lifetimeSeconds: 3600,
      idleSeconds: 900,
      mounts: [
        { path: "/inputs", prefix: referencePrefix("scan"), access: "read-only", stage: true },
        { path: "/scratch", prefix: scratchPrefix(runId), access: "read-write" },
        { path: "/outputs", prefix: outputsPrefix(runId), access: "read-write" },
      ],
    }),
  (state, detail) =>
    eventLog.append({
      id: randomUUID(),
      runId,
      threadId,
      createdAt: new Date().toISOString(),
      type: "sandbox",
      payload: { name: "main", state, detail },
    }),
);

const abort = new AbortController();
process.on("SIGINT", () => {
  if (abort.signal.aborted) process.exit(130);
  console.error("\ninterrupted: stopping the running command (Ctrl-C again to quit now)");
  abort.abort();
});

console.log(`run ${runId}  thread ${threadId}  model ${provider}/${modelId}`);
try {
  const resuming = (await api.load(threadId)).length > 0;
  const outcome = await runThread({
    runId,
    threadId,
    kind: "worker",
    model,
    streamFn: models.streamSimple.bind(models),
    systemPrompt: SYSTEM_PROMPT,
    prompt: resuming ? RESUME_PROMPT : task,
    tools: [bashTool],
    eventLog,
    history: api,
    sandbox: () => sandbox.get(),
    signal: abort.signal,
  });
  const u = outcome.usage;
  console.log(
    `\n${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}\n` +
      `model usage this invocation: ${u.input} in, ${u.cacheRead} cache read, ${u.cacheWrite} cache write, ` +
      `${u.output} out, $${u.cost.toFixed(4)}`,
  );
  process.exitCode = outcome.status === "completed" ? 0 : 1;
} finally {
  await sandbox.close();
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
    case "tool.output":
      break;
    case "tool.result":
      console.log(`[result ${p.toolCallId}${p.truncated ? " truncated" : ""}] ${clip(p.output)}`);
      break;
    default:
      console.log(`[${event.type}] ${clip(p)}`);
  }
}
