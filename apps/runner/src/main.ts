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
import { CLAIM_POLL_SECONDS } from "@voluma/contracts/runner";
import { claimRun } from "@voluma/harness/adapters/http/hand-off";
import { r2Store } from "@voluma/object-store/r2";
import { runnerConfig } from "./config.ts";
import { PROVIDERS } from "./providers.ts";
import { redactor } from "./redact.ts";
import { type RunnerContext, runClaim } from "./run.ts";
import { startTelemetry } from "./telemetry.ts";
import { assertThinking } from "./thinking.ts";

/** How long a shutdown waits for runs to report before it exits anyway. */
const SHUTDOWN_BUDGET_MS = 30_000;

const config = runnerConfig();
const redact = redactor(config.secrets);
const log = (line: string) => console.log(`${new Date().toISOString()} ${redact(line)}`);

const models = createModels();
for (const provider of Object.values(PROVIDERS)) models.setProvider(provider());
const resolve = (ref: { provider: string; id: string }) => {
  const model = models.getModel(ref.provider, ref.id);
  if (!model) throw new Error(`unknown model ${ref.provider}/${ref.id}`);
  return model;
};
const aliases = Object.fromEntries(
  Object.entries(config.models).map(([alias, ref]) => [alias, resolve(ref)]),
);

// Pi clamps a level a model lacks to a neighbouring one, so a typo'd or unsupported level
// would run silently at another. Every alias is checked, named by a role file or not.
assertThinking(config.thinking, Object.values(aliases), "RUNNER_THINKING");

const runnerId = `runner-${randomUUID().slice(0, 8)}`;
const ctx: RunnerContext = {
  config,
  models,
  aliases,
  visitorModel: resolve(config.visitorModel),
  objects: r2Store(config.r2),
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

const aliasList = Object.entries(config.models)
  .map(([alias, m]) => `${alias} ${m.provider}/${m.id}`)
  .join(", ");
const gatewayNote = config.gateway?.url ?? "off: segment_sam not offered";
log(
  `${runnerId} up: ${config.concurrency} slot(s), models ${aliasList}, thinking ${config.thinking ?? "unset"}, api ${config.api.baseUrl}, gateway ${gatewayNote}`,
);
// After startup: a failure above must still kill the process, not be logged and survived.
startTelemetry(log);
// The process handlers (`telemetry.ts`) keep the process alive past a stray error, so a loop
// that dies must exit non-zero itself, or a restart-on-failure policy never sees it.
try {
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
} catch (error) {
  log(`claim loop died: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
  process.exit(1);
}

await Promise.race([
  Promise.allSettled(active),
  new Promise((resolve) => setTimeout(resolve, SHUTDOWN_BUDGET_MS)),
]);
log("exited");
process.exit(0);
