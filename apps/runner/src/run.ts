/**
 * One claimed run, start to report: the same path for a fresh run and a recovered one. It
 * reads the run's stored events over HTTP, builds the recorder on them and one sandbox
 * session, and hands the harness its adapters (`superviseRun`). Alongside, it holds the lease
 * (`lease.ts`) and stops at once on any of: the server ending the run, a lost lease, a
 * self-stop, or the service shutting down. Then it reports.
 *
 * A visitor run uses the claim's keys for the model and for Modal, held in this function's
 * scope only. Everything that leaves the process goes through the run's `redact`: the
 * run client (`runClient`) redacts what it sends, the console line is redacted before it is
 * clipped. The function never rejects: every failure after `redact` exists is caught and
 * logged through it.
 *
 * End of the run, in order. A normal end closes the sandbox first, so its `stopped` event
 * and last seconds go out under the live lease, then reports. A stop (shutdown, self-stop)
 * reports `released` first, so the run is recovered within the platform's grace period,
 * then closes the sandbox. A stop by the server or a lost lease reports nothing.
 */
import { randomUUID } from "node:crypto";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { inputPrefix, referencePrefix } from "@voluma/contracts/r2";
import type { Claim, ReportRequest } from "@voluma/contracts/runner";
import { runClient } from "@voluma/harness/adapters/http/run-client";
import { llmJudgment } from "@voluma/harness/judgment";
import { runLayout } from "@voluma/harness/layout";
import { type Recorder, recorder } from "@voluma/harness/recorder";
import { type SandboxSession, sandboxSession } from "@voluma/harness/sandbox-session";
import { type RunRole, superviseRun } from "@voluma/harness/supervise-run";
import { checkToolNames } from "@voluma/harness/tools";
import { loadWorkflow } from "@voluma/workflow/load";
import type { Config } from "./config.ts";
import { holdLease, type StopReason } from "./lease.ts";
import { eventLine } from "./log.ts";
import { createModalSandbox, RUNS_APP, terminateClaim } from "./modal-sandbox.ts";
import { checkPrompt, checkSystem, workerPrompt, workerSystem } from "./prompts.ts";
import { r2Evidence } from "./r2-evidence.ts";
import { r2Workflows } from "./r2-workflows.ts";
import { type Redact, redactor } from "./redact.ts";
import { usageMeter } from "./usage.ts";

/**
 * How long closing the sandbox may take before Modal is asked to terminate the claim's by
 * tag. Terminating takes tens of seconds, so a normal end waits longer (the lease is held
 * meanwhile, and the `stopped` event needs the close to finish); after a stop, the run's
 * report waits only on the platform's grace period.
 */
const CLOSE_BUDGET_MS = { ended: 60_000, stopped: 15_000 };
/** How long threads get to end after a stop before the run is reported anyway. */
const WIND_DOWN_MS = 5_000;

export interface RunnerContext {
  config: Config;
  models: Models;
  /** The models the config names, resolved at startup. */
  model: Model<Api>;
  visitorModel: Model<Api>;
  log(line: string): void;
}

type Stopped = StopReason | "shutdown";

/** Which report a stop reason, a clean end or a failure becomes; undefined: say nothing more. */
function reportFor(
  stopped: Stopped | undefined,
  error?: string,
): ReportRequest["report"] | undefined {
  if (stopped === "stop" || stopped === "lease-lost") return undefined;
  if (stopped === "self-stop" || stopped === "shutdown") return { kind: "released" };
  return error === undefined
    ? { kind: "ended", outcome: "completed" }
    : { kind: "ended", outcome: "failed", error };
}

export async function runClaim(
  ctx: RunnerContext,
  claim: Claim,
  shutdown: AbortSignal,
): Promise<void> {
  const { config, models } = ctx;
  const { run, leaseToken, keys } = claim;
  const runId = run.id;
  const claimId = randomUUID();
  const visitor = keys !== undefined;
  const model = visitor ? ctx.visitorModel : ctx.model;
  const apiKey = visitor ? keys.metaApiKey : config.model.apiKey;
  const modal = visitor ? keys.modal : config.modal;
  const redact: Redact = redactor([
    ...config.secrets,
    ...(visitor ? [keys.metaApiKey, keys.modal.tokenId, keys.modal.tokenSecret] : []),
  ]);
  const log = (line: string) => ctx.log(`[${runId}] ${redact(line)}`);

  const abort = new AbortController();
  // An object, so TypeScript does not narrow what the callbacks set.
  const why: { stopped?: Stopped } = {};
  const stop = (reason: Stopped) => {
    why.stopped ??= reason;
    abort.abort();
  };
  // The shutdown signal outlives this run: the listener is removed in `finally`.
  const onShutdown = () => stop("shutdown");
  shutdown.addEventListener("abort", onShutdown);
  if (shutdown.aborted) stop("shutdown");

  const meter = usageMeter();
  const client = runClient(
    config.api,
    { runId, leaseToken },
    { redact, onLeaseLost: () => stop("lease-lost") },
  );
  let lease: ReturnType<typeof holdLease> | undefined;
  let events: Recorder | undefined;
  let session: SandboxSession | undefined;
  let error: string | undefined;
  try {
    lease = holdLease({ client, meter, onStop: stop, log });
    log(`claimed (${visitor ? "visitor" : "voluma"} keys, model ${model.provider}/${model.id})`);

    // Before any sandbox: an unreadable package or an unknown tool fails the run here, with its message.
    const definition = await loadWorkflow(run.workflows, {
      store: r2Workflows(config.r2),
      githubToken: config.githubToken,
      signal: abort.signal,
    });
    const { worker: workerAgent, checker: checkerAgent } = definition.roles;
    // Every assigned role's tools are checked now, so an unknown name fails at start whichever
    // role it is on; main and review are not started yet, which the log says.
    for (const [role, agent] of Object.entries(definition.roles)) {
      checkToolNames(agent.tools, agent.name);
      if (role === "main" || role === "review") {
        log(`role ${role} is assigned to ${agent.name}, which this runner does not run yet`);
      }
    }

    const layout = runLayout(
      runId,
      run.input.source === "reference" ? referencePrefix("scan") : inputPrefix(run.input.id),
      run.workflows,
    );
    const createSandbox = createModalSandbox({
      appName: RUNS_APP,
      claim: claimId,
      modal,
      r2: {
        accountId: config.r2.accountId,
        bucket: config.r2.bucket,
        parentAccessKeyId: config.r2.accessKeyId,
        cloudflareApiToken: config.r2.cloudflareApiToken,
      },
    });
    const stored = await client.storedEvents();
    // A resumed run keeps the plan its first event recorded; only a new run takes the parsed one.
    const recorded = stored.find(
      (e) => e.type === "revision.started" && e.payload.reason === "run",
    );
    const plan =
      recorded?.type === "revision.started" && recorded.payload.reason === "run"
        ? recorded.payload.plan
        : definition.plan;
    events = recorder(
      {
        async append(event) {
          await client.append(event);
          log(eventLine(event, redact));
        },
      },
      runId,
      () => stop("lease-lost"),
      undefined,
      stored,
    );
    session = sandboxSession(
      () =>
        createSandbox({
          runId,
          name: "main",
          image: config.sandbox.image,
          cpu: 2,
          memoryMiB: 4096,
          lifetimeSeconds: config.sandbox.lifetimeSeconds,
          idleSeconds: config.sandbox.idleSeconds,
          mounts: layout.mounts,
        }),
      (id, state, detail) => {
        if (state === "ready") meter.sandboxUp();
        else if (state === "stopped" || state === "failed") meter.sandboxDown();
        events?.emit(id, "sandbox", { name: "main", state, detail });
      },
      layout.restartNote,
    );
    const opened = session;

    const streamFn: RunRole["streamFn"] = (m, context, options) => {
      const stream = models.streamSimple(m, context, { ...options, apiKey });
      stream.result().then(
        (reply) => meter.addModelCost(reply.usage.cost.total),
        () => {},
      );
      return stream;
    };
    const judgment = llmJudgment(`llm:${model.id}`, async (context, signal) => {
      const reply = await models.completeSimple(model, context, { apiKey, signal });
      meter.addModelCost(reply.usage.cost.total);
      return reply;
    });
    const supervised = superviseRun({
      runId,
      plan: plan.tasks,
      workflows: run.workflows,
      layout,
      recorder: events,
      history: client,
      sandbox: (id) => opened.get(id),
      evidence: r2Evidence(config.r2),
      judgment,
      worker: (task) => ({
        model,
        streamFn,
        systemPrompt: workerSystem(definition),
        prompt: workerPrompt(definition, task),
        tools: workerAgent.tools,
      }),
      check: (task) => ({
        model,
        streamFn,
        systemPrompt: checkSystem(definition),
        prompt: checkPrompt(definition, task),
        tools: checkerAgent?.tools,
      }),
      signal: abort.signal,
    });
    supervised.catch(() => {}); // an error after the race below is moot: the run is stopping
    // A stop does not wait for a thread stuck in a slow call (creating a sandbox takes a
    // minute): after a grace period the run is reported and the sandbox closed regardless.
    const windDown = new Promise<void>((resolve) => {
      const arm = () => setTimeout(resolve, WIND_DOWN_MS);
      if (abort.signal.aborted) arm();
      else abort.signal.addEventListener("abort", arm, { once: true });
    });
    await Promise.race([supervised, windDown]);
  } catch (e) {
    error = redact(e instanceof Error ? e.message : String(e));
    log(`failed: ${error}`);
  } finally {
    shutdown.removeEventListener("abort", onShutdown);
    // Frozen here: a stop that lands while the run is being closed does not change its report.
    const stopped = why.stopped;
    const report = reportFor(stopped, error);
    abort.abort();
    if (stopped === undefined) await closeSandbox(CLOSE_BUDGET_MS.ended);
    await events?.flush();
    await lease?.end(report !== undefined);
    if (report) {
      await client
        .report(report)
        .catch((e) => log(`report failed: ${e instanceof Error ? e.message : e}`));
      log(`reported ${report.kind}${report.kind === "ended" ? ` ${report.outcome}` : ""}`);
    } else {
      log(`stopped (${stopped}); nothing more to report`);
    }
    if (stopped !== undefined) await closeSandbox(CLOSE_BUDGET_MS.stopped);
  }

  async function closeSandbox(budgetMs: number) {
    if (!session) return;
    const closed = session.close().then(
      () => true,
      () => false,
    );
    const timeout = new Promise<false>((resolve) => setTimeout(resolve, budgetMs, false));
    if (!(await Promise.race([closed, timeout]))) {
      log("sandbox did not close in time; terminating this claim's sandboxes");
      await terminateClaim(modal, runId, claimId).catch((e) => log(`terminate failed: ${e}`));
    }
  }
}
