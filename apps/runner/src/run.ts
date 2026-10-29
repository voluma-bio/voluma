/**
 * One claimed run, start to report: the same path for a fresh run and a recovered one. It
 * reads the run's stored events over HTTP, builds the recorder on them and the sandbox
 * session (one sandbox per thread), and hands the harness its adapters (`superviseRun`). Alongside, it holds the lease
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
 * reports `released` with its reason first, so the run is recovered within the platform's
 * grace period, then closes the sandbox. A stop by the server or a lost lease reports nothing.
 * None of these stops writes a `thread.ended`: the threads are cut off, and the next claim
 * (which learns why from `claim.previousClaim`) resumes them (`supervisor.ts`).
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import {
  inputPrefix,
  referencePrefix,
  scratchKey,
  workflowSnapshotPrefix,
} from "@voluma/contracts/r2";
import type { Claim, ReportRequest } from "@voluma/contracts/runner";
import { runClient } from "@voluma/harness/adapters/http/run-client";
import { runLayout } from "@voluma/harness/layout";
import { type LiveBatcher, liveBatcher } from "@voluma/harness/live";
import { llmMainThread, mainSystem, runBrief } from "@voluma/harness/main-thread";
import { usageOf } from "@voluma/harness/model-usage";
import { type Recorder, recorder } from "@voluma/harness/recorder";
import { type SandboxSession, sandboxSession } from "@voluma/harness/sandbox-session";
import { checkerSandboxSpec, workerSandboxSpec } from "@voluma/harness/sandbox-specs";
import { type RunRole, superviseRun } from "@voluma/harness/supervise-run";
import { optionalTools, TOOL_NAMES } from "@voluma/harness/tools";
import { loadWorkflow } from "@voluma/workflow/load";
import { computePlan } from "@voluma/workflow/plan";
import { type Config, isVisitorSafe, providerKey } from "./config.ts";
import { holdLease, type StopReason } from "./lease.ts";
import { eventLine } from "./log.ts";
import { metaSegmenter } from "./meta-segmenter.ts";
import {
  createModalSandbox,
  RUNS_APP,
  terminateClaim,
  terminateOtherClaims,
} from "./modal-sandbox.ts";
import type { ModelFallback } from "./model-fallback.ts";
import { retryTransient } from "./model-retry.ts";
import { checkPrompt, systemPrompt, workerPrompt } from "./prompts.ts";
import { isFatalProviderError, isProviderError } from "./provider-error.ts";
import { r2Evidence } from "./r2-evidence.ts";
import { r2Files } from "./r2-files.ts";
import { r2Workflows } from "./r2-workflows.ts";
import { type Redact, redactor } from "./redact.ts";
import { type ModelRole, usageMeter } from "./usage.ts";

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
/** Pi's own retries of a model call (429 honours retry-after, 5xx, dropped connections). */
const MODEL_RETRIES = 3;

export interface RunnerContext {
  config: Config;
  models: Models;
  /** The model behind each alias the config sets (`config.models`), resolved at startup. */
  aliases: Record<string, Model<Api>>;
  visitorModel: Model<Api>;
  /** Starts worker and check threads on the fallback model while their model is failing. */
  fallback: ModelFallback;
  log(line: string): void;
}

type Stopped = StopReason | "shutdown" | "spend-cap";

/** Which report a stop reason, a clean end or a failure becomes; undefined: say nothing more. */
export function reportFor(
  stopped: Stopped | undefined,
  error?: string,
): ReportRequest["report"] | undefined {
  if (stopped === "stop" || stopped === "lease-lost") return undefined;
  if (stopped === "self-stop" || stopped === "shutdown")
    return { kind: "released", reason: stopped };
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

  // The run's dollars across every claim, gateway calls included: what the server last
  // acknowledged (a heartbeat's `spentUsd`) plus the model cost not yet sent. Crossing the cap
  // stops everything in flight; the run then ends `failed` naming it.
  let acknowledgedUsd = (run.usage?.modelCostUsd ?? 0) + (run.providerCalls?.costUsd ?? 0);
  let capError: string | undefined;
  const checkCap = () => {
    const total = acknowledgedUsd + meter.pendingModelCostUsd();
    if (capError || config.maxRunCostUsd === undefined || total < config.maxRunCostUsd) return;
    capError = `spend cap $${config.maxRunCostUsd} reached at $${total.toFixed(2)}`;
    log(capError);
    stop("spend-cap");
  };
  const meter = usageMeter(checkCap);
  checkCap(); // a resumed run that is already over the cap makes no call
  const client = runClient(
    config.api,
    { runId, leaseToken },
    { redact, onLeaseLost: () => stop("lease-lost") },
  );
  let lease: ReturnType<typeof holdLease> | undefined;
  let events: Recorder | undefined;
  let live: LiveBatcher | undefined;
  let session: SandboxSession | undefined;
  let error: string | undefined;
  try {
    lease = holdLease({
      client,
      meter,
      onStop: stop,
      onSpent(usd) {
        acknowledgedUsd = usd;
        checkCap();
      },
      log,
    });
    log(`claimed (${visitor ? "visitor" : "voluma"} keys)`);

    // What an earlier claim of this run left running must not keep writing or spending.
    // Cleanup only: it never decides the run's outcome, and idle timeouts back it up.
    for (let attempt = 1; attempt <= 2 && !abort.signal.aborted; attempt++) {
      try {
        const orphans = await terminateOtherClaims(modal, runId, claimId, abort.signal);
        if (orphans > 0)
          log(`ended ${orphans} sandbox${orphans === 1 ? "" : "es"} of an earlier claim`);
        break;
      } catch (e) {
        log(`ending an earlier claim's sandboxes failed (attempt ${attempt}): ${e}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Before any sandbox: an unreadable workflow or a bad selection fails the run here, with its
    // message. The run's pin names the workflow directory; its files are snapshotted from this
    // runner's checkout once (at `config.commit`), so a resume reads what the run began with.
    const workflowDir = run.workflows[0]?.path;
    if (!workflowDir) throw new Error("the run pins no workflow directory");
    const definition = await loadWorkflow(workflowDir, {
      store: r2Workflows(config.r2),
      prefix: workflowSnapshotPrefix(runId),
      root: REPO_ROOT,
      commit: config.commit,
      knownTools: TOOL_NAMES,
    });
    // A role's model is its file's alias. A visitor's key and scan go to Standard-mode Meta
    // models only: the main thread keeps its configured model when that is one, else the
    // visitor model.
    const roleModel = (role: "worker" | "checker" | "main") => {
      const alias = definition.agents[role].model;
      const model = ctx.aliases[alias];
      if (!model)
        throw new Error(
          `the ${role} role names model "${alias}", which RUNNER_MODEL_${alias.toUpperCase()} does not set`,
        );
      return !visitor || (role === "main" && isVisitorSafe(model)) ? model : ctx.visitorModel;
    };
    const workerModel = roleModel("worker");
    const checkModel = roleModel("checker");
    const mainModel = roleModel("main");
    log(`models: worker ${workerModel.id}, checker ${checkModel.id}, main ${mainModel.id}`);
    // The tasks that produce the selected outputs and what they need. The main thread may adapt
    // them to the run's notes when the run starts (`superviseRun`).
    const computed = computePlan(definition.files, run.selectedOutputs);
    // Each role's optional tools are the ones its file lists. `segment_sam` needs a key, and only
    // workers hold it: it calls out to Meta and `keepFailed` writes the run-wide scratch.
    const grant = (role: "worker" | "checker") =>
      definition.agents[role].tools.filter(
        (t) =>
          Object.hasOwn(optionalTools, t) &&
          (t !== "segment_sam" || (role === "worker" && metaKey)),
      );

    const layout = runLayout(
      runId,
      run.input.source === "reference" ? referencePrefix("scan") : inputPrefix(run.input.id),
      definition.skills,
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
    live = liveBatcher((frames) => client.live(frames));
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
      live,
    );
    session = sandboxSession(
      (threadId) => {
        const thread = layout.forThread(threadId);
        const common = {
          runId,
          name: thread.name,
          image: config.sandbox.image,
          lifetimeSeconds: config.sandbox.lifetimeSeconds,
          idleSeconds: config.sandbox.idleSeconds,
          env: thread.env,
          workdir: thread.dir,
        };
        return createSandbox(
          thread.role === "worker"
            ? workerSandboxSpec({ ...common, mounts: thread.mounts })
            : checkerSandboxSpec({
                ...common,
                readOnly: thread.mounts.filter((m) => m !== thread.scratch),
                scratch: thread.scratch,
              }),
          abort.signal,
        );
      },
      (id, state, detail) => {
        // Metered from the start of creation, the sweep included: a conservative upper bound.
        if (state === "starting") meter.sandboxUp();
        else if (state === "stopped" || state === "failed") meter.sandboxDown();
        events?.emit(id, "sandbox", { name: layout.forThread(id).name, state, detail });
      },
      (threadId) => layout.forThread(threadId).restartNote,
    );
    const opened = session;

    // A thread keeps the model it started on (the log records it); a new one starts on the
    // fallback while the primary is failing. A visitor's run never falls back: their key and
    // scan go to Standard-mode Meta only.
    const threadModel = (primary: Model<Api>, recorded: string | undefined) => {
      if (recorded) {
        // Only a model this run may use: a visitor's scan goes to Standard-mode Meta only, and
        // a fallback that was switched off stays off for threads that started on it.
        const [provider = "", ...id] = recorded.split("/");
        const allowed = visitor
          ? isVisitorSafe({ provider, id: id.join("/") })
          : [workerModel, checkModel, mainModel, config.fallbackModel].some(
              (m) => m && `${m.provider}/${m.id}` === recorded,
            );
        const model = allowed ? models.getModel(provider, id.join("/")) : undefined;
        if (!model)
          throw new Error(`the thread started on ${recorded}, which this run may not use`);
        return model;
      }
      return visitor ? primary : ctx.fallback.pick(primary);
    };
    const callModel = (role: ModelRole) =>
      retryTransient(
        (m, context, options) =>
          models.streamSimple(m, context, {
            ...options,
            apiKey: keyFor(m.provider),
            maxRetries: MODEL_RETRIES,
          }),
        (m, attempt, delayMs, error) => {
          log(
            `${role} model call failed (${error}); retry ${attempt} in ${Math.round(delayMs / 1000)}s`,
          );
          // Threads that start while this one retries should not wait out the same outage.
          if (!visitor) ctx.fallback.failed(m, error);
        },
      );
    const streamFor =
      (role: ModelRole): RunRole["streamFn"] =>
      (m, context, options) => {
        const stream = callModel(role)(m, context, options);
        stream.result().then(
          (reply) => {
            meter.addModelCall(role, usageOf(reply));
            if (reply.stopReason === "error" && !visitor)
              ctx.fallback.failed(m, reply.errorMessage);
          },
          () => {},
        );
        return stream;
      };
    const main = llmMainThread(
      mainModel,
      mainSystem(runBrief(run.selectedOutputs, computed.tasks)),
      async (context, signal, onEvent) => {
        const stream = callModel("main")(mainModel, context, { signal });
        // The stream's events and its result are independent: draining one leaves the other.
        const drained = (async () => {
          if (onEvent) for await (const event of stream) onEvent(event);
        })();
        const [reply] = await Promise.all([stream.result(), drained]);
        meter.addModelCall("main", usageOf(reply));
        return reply;
      },
    );
    const files = r2Files(config.r2);
    const supervised = superviseRun({
      runId,
      plan: computed.tasks,
      selectedOutputs: run.selectedOutputs,
      notes: run.notes,
      previousClaim: claim.previousClaim?.reason,
      providerError: isProviderError,
      // With a fallback model set, the redo starts on it, so even a refused key is not the end.
      providerFatal: (error) => !config.fallbackModel && isFatalProviderError(error),
      workflow: definition.files,
      // The commit the files came from: the snapshot's, which a resume keeps.
      workflows: run.workflows.map((pin) => ({ ...pin, commit: definition.commit })),
      layout,
      recorder: events,
      history: client,
      sandbox: (id) => opened.get(id),
      releaseSandbox: (id) =>
        opened.release(id).catch((e) => log(`releasing ${layout.forThread(id).name} failed: ${e}`)),
      evidence: r2Evidence(config.r2),
      files,
      segmenter: metaKey
        ? metaSegmenter({
            apiKey: metaKey,
            log,
            addCost: meter.addModelCost,
            keepFailed: async (text) => {
              // Only workers hold segment_sam, so the run-wide scratch is theirs.
              const name = `failed-sam-response-${new Date().toISOString().replaceAll(":", "-")}.txt`;
              const path = `/scratch/${name}`;
              await files.write(
                scratchKey(runId, name),
                new TextEncoder().encode(text),
                AbortSignal.timeout(60_000),
              );
              return `kept at ${path}`;
            },
          })
        : undefined,
      main,
      worker: (task, thread, notes, recorded) => ({
        model: threadModel(workerModel, recorded),
        streamFn: streamFor("worker"),
        systemPrompt: systemPrompt(definition, thread),
        prompt: workerPrompt(task, { user: run.notes, main: notes }),
        tools: grant("worker"),
      }),
      check: (task, thread, notes, recorded) => ({
        model: threadModel(checkModel, recorded),
        streamFn: streamFor("check"),
        systemPrompt: systemPrompt(definition, thread),
        prompt: checkPrompt(task, { user: run.notes, main: notes }),
        tools: grant("checker"),
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
    const report = reportFor(stopped, stopped === "spend-cap" ? capError : error);
    abort.abort();
    // An ended run closes its sandbox while the lease is live; a released one reports first.
    if (report?.kind === "ended") await closeSandbox(CLOSE_BUDGET_MS.ended);
    await live?.flush();
    await events?.flush();
    await lease?.end(report !== undefined);
    if (report) {
      await client
        .report(report)
        .catch((e) => log(`report failed: ${e instanceof Error ? e.message : e}`));
      log(`reported ${report.kind}${report.kind === "ended" ? ` ${report.outcome}` : ""}`);
      if (live) {
        const { frames, requests, dropped } = live.stats();
        log(`live frames this claim: ${frames} in ${requests} requests, ${dropped} dropped`);
      }
      log(`model cost this claim: $${meter.totalModelCostUsd().toFixed(4)}`);
      for (const line of meter.cacheSummary()) log(`model usage this claim, ${line}`);
    } else {
      log(`stopped (${stopped}); nothing more to report`);
    }
    if (report?.kind !== "ended") await closeSandbox(CLOSE_BUDGET_MS.stopped);
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
