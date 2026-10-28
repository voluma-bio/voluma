/**
 * The runner service: claims runs from the API and runs them (`pnpm --filter @voluma/runner start`).
 * While it has a free slot (RUNNER_CONCURRENCY) it asks for a run every CLAIM_POLL_SECONDS;
 * each claim runs in `run.ts`. On SIGTERM or SIGINT it stops every run, which reports
 * `released` so the API recovers it at once, and exits. A second signal exits immediately;
 * a sandbox it leaves is ended by Modal's idle timeout, or by `sandboxes:clean`.
 * Settings: config.ts and `.env.example`.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { CLAIM_POLL_SECONDS } from "@voluma/contracts/runner";
import { claimRun } from "@voluma/harness/adapters/http/hand-off";
import { runnerConfig } from "./config.ts";
import { redactor } from "./redact.ts";
import { type RunnerContext, runClaim } from "./run.ts";

/** How long a shutdown waits for runs to report before it exits anyway. */
const SHUTDOWN_BUDGET_MS = 30_000;

const config = runnerConfig();
const redact = redactor(config.secrets);
const log = (line: string) => console.log(`${new Date().toISOString()} ${redact(line)}`);

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(metaProvider());
models.setProvider(openaiProvider());
const resolve = (ref: { provider: string; id: string }) => {
  const model = models.getModel(ref.provider, ref.id);
  if (!model) throw new Error(`unknown model ${ref.provider}/${ref.id}`);
  return model;
};
const model = resolve(config.model);

const runnerId = `runner-${randomUUID().slice(0, 8)}`;
const ctx: RunnerContext = {
  config,
  models,
  model,
  visitorModel: resolve(config.visitorModel),
  log,
};

const shutdown = new AbortController();
const active = new Set<Promise<void>>();
let signals = 0;
for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.on(name, () => {
    if (++signals > 1) process.exit(130);
    log(`${name}: releasing ${active.size} run(s) and exiting`);
    shutdown.abort();
  });
}

const shuttingDown = new Promise<void>((resolve) =>
  shutdown.signal.addEventListener("abort", () => resolve(), { once: true }),
);
// Aborts on shutdown, and removes its own listener when it settles.
const sleep = (ms: number) => delay(ms, undefined, { signal: shutdown.signal }).catch(() => {});

log(
  `${runnerId} up: ${config.concurrency} slot(s), model ${config.model.provider}/${config.model.id}, api ${config.api.baseUrl}`,
);
while (!shutdown.signal.aborted) {
  if (active.size >= config.concurrency) {
    await Promise.race([...active, shuttingDown]);
    continue;
  }
  let claim: Awaited<ReturnType<typeof claimRun>>;
  try {
    claim = await claimRun(config.api, runnerId);
  } catch (error) {
    log(`claim failed: ${error instanceof Error ? error.message : error}`);
    await sleep(CLAIM_POLL_SECONDS * 1000);
    continue;
  }
  if (!claim) {
    await sleep(CLAIM_POLL_SECONDS * 1000);
    continue;
  }
  // `runClaim` never rejects: it logs its own failures through the run's redaction.
  const done = runClaim(ctx, claim, shutdown.signal).finally(() => active.delete(done));
  active.add(done);
}

await Promise.race([
  Promise.allSettled(active),
  new Promise((resolve) => setTimeout(resolve, SHUTDOWN_BUDGET_MS)),
]);
log("exited");
process.exit(0);
