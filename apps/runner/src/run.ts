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
import { resolve } from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { inputPrefix, referencePrefix, workflowSnapshotPrefix } from "@voluma/contracts/r2";
import type { Claim, ReportRequest } from "@voluma/contracts/runner";
import { runClient } from "@voluma/harness/adapters/http/run-client";
import { runLayout } from "@voluma/harness/layout";
import { llmMainThread, mainSystem, runBrief } from "@voluma/harness/main-thread";
import { type Recorder, recorder } from "@voluma/harness/recorder";
import { type SandboxSession, sandboxSession } from "@voluma/harness/sandbox-session";
import { type RunRole, superviseRun } from "@voluma/harness/supervise-run";
import { checkToolNames } from "@voluma/harness/tools";
import { loadWorkflow } from "@voluma/workflow/load";
import { computePlan } from "@voluma/workflow/plan";
import { type Config, isVisitorSafe, providerKey } from "./config.ts";
import { holdLease, type StopReason } from "./lease.ts";
import { eventLine } from "./log.ts";
import { metaSegmenter } from "./meta-segmenter.ts";
import { createModalSandbox, RUNS_APP, terminateClaim } from "./modal-sandbox.ts";
import { withModelRetry } from "./model-retry.ts";
import { checkPrompt, checkSystem, workerPrompt, workerSystem } from "./prompts.ts";
import { r2Evidence } from "./r2-evidence.ts";
import { r2Files } from "./r2-files.ts";
import { r2Workflows } from "./r2-workflows.ts";
import { type Redact, redactor } from "./redact.ts";
import { usageMeter } from "./usage.ts";

/**
 * How long closing the sandbox may take before Modal is asked to terminate the claim's by
 * tag. Terminating takes tens of seconds, so a normal end waits longer (the lease is held
 * meanwhile, and the `stopped` event needs the close to finish); after a stop, the run's
 * report waits only on the platform's grace period.
 */
/** The repo checkout this runner was deployed from: `workflows/` is read from it. */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CLOSE_BUDGET_MS = { ended: 60_000, stopped: 15_000 };
/** How long threads get to end after a stop before the run is reported anyway. */
const WIND_DOWN_MS = 5_000;

export interface RunnerContext {
  config: Config;
  models: Models;
  /** The models the config names for a `voluma` run's roles, resolved at startup. */
  roles: Record<"worker" | "check" | "main", Model<Api>>;
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
  // A visitor's key and scan go to Standard-mode Meta models only: the main thread keeps its
  // configured model when that is one, else the visitor model.
  const roleModel = (role: "worker" | "check" | "main") =>
    !visitor
      ? ctx.roles[role]
      : role === "main" && isVisitorSafe(config.roles.main)
        ? ctx.roles.main
        : ctx.visitorModel;
  const workerModel = roleModel("worker");
  const checkModel = roleModel("check");
  const mainModel = roleModel("main");
  /** The key for a provider: a visitor's Meta key is good for Meta alone. */
  const keyFor = (provider: string) =>
    visitor ? (provider === "meta" ? keys.metaApiKey : undefined) : providerKey(provider);
  const modal = visitor ? keys.modal : config.modal;
  const metaKey = visitor ? keys.metaApiKey : config.metaApiKey;
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
    log(
      `claimed (${visitor ? "visitor" : "voluma"} keys, model ${workerModel.provider}/${workerModel.id})`,
    );

    // Before any sandbox: an unreadable workflow or an unknown tool fails the run here, with its message.
    // The run's pin names the workflow directory; its files are snapshotted from this
    // runner's checkout once, so a resume reads what the run began with.
    const workflowDir = run.workflows[0]?.path;
    if (!workflowDir) throw new Error("the run pins no workflow directory");
    const definition = await loadWorkflow(workflowDir, {
      store: r2Workflows(config.r2),
      prefix: workflowSnapshotPrefix(runId),
      root: REPO_ROOT,
    });
    // The tasks that produce the selected outputs and what they need. The main thread may adapt
    // them to the run's notes when the run starts (`superviseRun`).
    const computed = computePlan(definition.files, run.selectedOutputs);
    // Every role's tools come from here, not from the workflow.
    const roleTools = ["view_image", ...(metaKey ? ["segment_sam"] : [])];
    checkToolNames(roleTools, "runner");

    const layout = runLayout(
      runId,
      run.input.source === "reference" ? referencePrefix("scan") : inputPrefix(run.input.id),
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

    const callModel = withModelRetry((m, context, options) =>
      models.streamSimple(m, context, { ...options, apiKey: keyFor(m.provider) }),
    );
    const streamFn: RunRole["streamFn"] = (m, context, options) => {
      const stream = callModel(m, context, options);
      stream.result().then(
        (reply) => meter.addModelCost(reply.usage.cost.total),
        () => {},
      );
      return stream;
    };
    const main = llmMainThread(
      mainModel,
      mainSystem(runBrief(run.selectedOutputs, computed.tasks)),
      async (context, signal) => {
        const reply = await callModel(mainModel, context, { signal }).result();
        meter.addModelCost(reply.usage.cost.total);
        return reply;
      },
    );
    const files = r2Files(config.r2);
    const supervised = superviseRun({
      runId,
      plan: computed.tasks,
      selectedOutputs: run.selectedOutputs,
      notes: run.notes,
      workflow: definition.files,
      workflows: run.workflows,
      layout,
      recorder: events,
      history: client,
      sandbox: (id) => opened.get(id),
      evidence: r2Evidence(config.r2),
      files,
      segmenter: metaKey
        ? metaSegmenter({ apiKey: metaKey, log, addCost: meter.addModelCost })
        : undefined,
      main,
      worker: (task, notes) => ({
        model: workerModel,
        streamFn,
        systemPrompt: workerSystem(definition),
        prompt: workerPrompt(definition, task, { user: run.notes, main: notes }),
        tools: roleTools,
      }),
      check: (task, notes) => ({
        model: checkModel,
        streamFn,
        systemPrompt: checkSystem(definition),
        prompt: checkPrompt(definition, task, { user: run.notes, main: notes }),
        tools: roleTools,
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
      log(`model cost this claim: $${meter.totalModelCostUsd().toFixed(4)}`);
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
