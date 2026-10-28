/**
 * One claimed run, start to report: the same path for a fresh run and a recovered one. It
 * reads the run's stored events and history over HTTP, builds the recorder, task runtime,
 * threads, judgment and supervisor on them, with one sandbox session, and runs the
 * supervisor. Alongside, it holds the lease (`lease.ts`) and stops at once on any of: the
 * server ending the run, a lost lease (on events, history or heartbeat), a self-stop, or the
 * service shutting down. Then it reports (`reportFor`).
 *
 * A visitor run uses the claim's keys for the model and for Modal, held in this function's
 * scope only. Everything that leaves the process goes through the run's `redact`.
 */
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { inputPrefix, referencePrefix } from "@voluma/contracts/r2";
import type { Claim } from "@voluma/contracts/runner";
import { httpClient } from "@voluma/harness/adapters/http";
import type { handOff } from "@voluma/harness/adapters/http/hand-off";
import { llmJudgment } from "@voluma/harness/judgment";
import { runLayout } from "@voluma/harness/layout";
import { LeaseLost } from "@voluma/harness/ports/lease-lost";
import { type Recorder, recorder } from "@voluma/harness/recorder";
import { sandboxSession } from "@voluma/harness/sandbox-session";
import { type RoleSpec, supervisor } from "@voluma/harness/supervisor";
import { taskRuntime } from "@voluma/harness/task-runtime";
import { threads } from "@voluma/harness/threads";
import { bashTool } from "@voluma/harness/tools/bash";
import { taskTools } from "@voluma/harness/tools/task-tools";
import { threadMessageTool } from "@voluma/harness/tools/thread-message";
import type { Config } from "./config.ts";
import { holdLease, reportFor, type StopReason } from "./lease.ts";
import { eventLine } from "./log.ts";
import { createModalSandbox, RUNS_APP, terminateRun } from "./modal-sandbox.ts";
import { CHECK_SYSTEM, checkPrompt, WORKER_SYSTEM, workerPrompt } from "./prompts.ts";
import { r2Evidence } from "./r2-evidence.ts";
import { type Redact, redactJson, redactor } from "./redact.ts";
import { usageMeter } from "./usage.ts";

/** How long closing the sandbox may take before Modal is asked to terminate the run's by tag. */
const CLOSE_BUDGET_MS = 15_000;
/** How long threads get to end after a stop before the run is reported anyway. */
const WIND_DOWN_MS = 5_000;

export interface RunnerContext {
  config: Config;
  api: ReturnType<typeof handOff>;
  models: Models;
  /** The models the config names, resolved at startup. */
  model: Model<Api>;
  visitorModel: Model<Api>;
  log(line: string): void;
}

export async function runClaim(
  ctx: RunnerContext,
  claim: Claim,
  shutdown: AbortSignal,
): Promise<void> {
  const { config, models } = ctx;
  const { run, plan, leaseToken, keys } = claim;
  const runId = run.id;
  const root = `${runId}.supervisor`; // the supervisor's own thread id (supervisor.ts)
  const visitor = keys !== undefined;
  const model = visitor ? ctx.visitorModel : ctx.model;
  const apiKey = visitor ? keys.metaApiKey : config.modelKey(model.provider);
  const modal = visitor ? keys.modal : config.modal;
  const redact: Redact = redactor([
    ...config.secrets,
    ...(visitor ? [keys.metaApiKey, keys.modal.tokenId, keys.modal.tokenSecret] : []),
  ]);
  const log = (line: string) => ctx.log(`[${runId}] ${redact(line)}`);

  const abort = new AbortController();
  // An object, so TypeScript does not narrow what the callbacks set.
  const why: { stopped?: StopReason | "shutdown" } = {};
  const stop = (reason: StopReason | "shutdown") => {
    why.stopped ??= reason;
    abort.abort();
  };
  shutdown.addEventListener("abort", () => stop("shutdown"), { once: true });
  if (shutdown.aborted) stop("shutdown");

  const meter = usageMeter();
  const lease = holdLease({ api: ctx.api, runId, leaseToken, meter, onStop: stop, log });
  log(`claimed (${visitor ? "visitor" : "voluma"} keys, model ${model.provider}/${model.id})`);

  const layout = runLayout(
    runId,
    run.input.source === "reference" ? referencePrefix("scan") : inputPrefix(run.input.id),
  );
  const createSandbox = createModalSandbox({
    appName: RUNS_APP,
    modal,
    r2: {
      accountId: config.r2.accountId,
      bucket: config.r2.bucket,
      parentAccessKeyId: config.r2.accessKeyId,
      cloudflareApiToken: config.r2.cloudflareApiToken,
    },
  });
  const session = sandboxSession(
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

  let error: string | undefined;
  let events: Recorder | undefined;
  try {
    const store = httpClient({ ...config.api, runId, leaseToken });
    const onHistoryError = (e: unknown): never => {
      if (e instanceof LeaseLost) stop("lease-lost");
      throw e;
    };
    // A lost lease on a history call stops the whole run, as on events (the recorder).
    const history = {
      load: (threadId: string) => store.load(threadId).catch(onHistoryError),
      appendMessage: (threadId: string, idx: number, message: string) =>
        store.appendMessage(threadId, idx, redact(message)).catch(onHistoryError),
    };
    const rec = recorder(
      {
        async append(event) {
          await store.append(redactJson(redact, event));
          log(eventLine(event));
        },
      },
      runId,
      () => stop("lease-lost"),
      undefined,
      await store.storedEvents(),
    );
    events = rec;

    const pool = threads(
      { runId, recorder: rec, history, sandbox: (id) => session.get(id) },
      abort.signal,
    );
    const runtime = taskRuntime({
      recorder: rec,
      evidence: r2Evidence(config.r2),
      runId,
      rootThreadId: root,
      plan: plan.tasks,
      stopThread: (id) => pool.abort(id),
    });
    const streamFn: RoleSpec["streamFn"] = (m, context, options) => {
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
    const tools = () => [
      bashTool(layout),
      ...taskTools(runtime),
      threadMessageTool((from, to, text) => sup.message(from, to, text)),
    ];
    const tasks = new Map(plan.tasks.map((t) => [t.id, t]));
    const task = (id: string) => {
      const t = tasks.get(id);
      if (!t) throw new Error(`${id} is not a task of the plan`);
      return t;
    };
    const sup = supervisor({
      runId,
      plan: plan.tasks,
      runtime,
      recorder: rec,
      threads: pool,
      judgment,
      worker: (id) => ({
        model,
        streamFn,
        systemPrompt: WORKER_SYSTEM,
        prompt: workerPrompt(task(id)),
        tools: tools(),
      }),
      check: (id) => ({
        model,
        streamFn,
        systemPrompt: CHECK_SYSTEM,
        prompt: checkPrompt(task(id)),
        tools: tools(),
      }),
      signal: abort.signal,
    });
    const supervised = sup.run(run.workflows);
    supervised.catch(() => {}); // an error after the race below is moot: the run is stopping
    // A stop does not wait for a thread stuck in a slow call (creating a sandbox takes a
    // minute): after a grace period the run is reported and the sandbox closed regardless.
    const windDown = new Promise<void>((resolve) =>
      abort.signal.addEventListener("abort", () => setTimeout(resolve, WIND_DOWN_MS), {
        once: true,
      }),
    );
    await Promise.race([supervised, windDown]);
  } catch (e) {
    error = redact(e instanceof Error ? e.message : String(e));
    log(`failed: ${error}`);
  } finally {
    abort.abort();
    // Report before the slow sandbox close, so a shutdown releases the run within the
    // platform's grace period; the next claimer ends any sandbox this one leaves.
    await events?.flush();
    await lease.end(why.stopped !== "stop" && why.stopped !== "lease-lost");
    const report = reportFor(why.stopped, { error });
    if (report) {
      await ctx.api
        .report(runId, leaseToken, report)
        .catch((e) => log(`report failed: ${e instanceof Error ? e.message : e}`));
      log(`reported ${report.kind}${report.kind === "ended" ? ` ${report.outcome}` : ""}`);
    } else {
      log(`stopped (${why.stopped}); nothing more to report`);
    }
    await closeSandbox();
  }

  async function closeSandbox() {
    const closed = session.close().then(
      () => true,
      () => false,
    );
    const timeout = new Promise<false>((resolve) => setTimeout(resolve, CLOSE_BUDGET_MS, false));
    if (!(await Promise.race([closed, timeout]))) {
      log("sandbox did not close in time; terminating the run's sandboxes");
      await terminateRun(modal, runId).catch((e) => log(`terminate failed: ${e}`));
    }
  }
}
