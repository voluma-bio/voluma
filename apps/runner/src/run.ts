/**
 * One claimed run, start to report: the same path for a fresh run and a recovered one. It
 * reads the run's stored events over HTTP, builds the recorder on them, and hands the harness
 * what holds keys and machines (`superviseRun`: the models, Modal sandboxes, the gateway's token).
 * The harness writes the prompts, the tool grants and each sandbox's spec. Alongside, it holds the lease
 * (`lease.ts`) and stops at once on any of: the server ending the run, a lost lease, a
 * self-stop, or the service shutting down. Then it reports.
 *
 * A visitor run uses the claim's Meta key for the model, held in this function's
 * scope only. Everything that leaves the process goes through the run's `redact`: the
 * run client (`runClient`) redacts what it sends, the console line is redacted before it is
 * clipped. The function never rejects: every failure after `redact` exists is caught and
 * logged through it.
 *
 * Beside the supervisor runs the harness's conversion worker (`review-assets.ts`): it turns
 * the files tasks report into review assets in a `convert` sandbox as they appear.
 *
 * The host gives `superviseRun` one signal, the cut-off: a stop that will not end the run
 * (shutdown, self-stop, refused, loop-stalled, lease lost, the server's stop). The supervisor
 * ends its own threads and, on a normal end, drains the conversion queue (bounded by `DRAIN_MS`,
 * the lease heartbeating meanwhile; every output left without an `assets.*` event is recorded
 * as failed, whatever step failed, `prepare` included). Its `result` says which happened: the run
 * ended, or it was cut off, a cut-off during the drain included, which records nothing.
 *
 * End of the run, in order. An ended run (an uncaught error included, via `Supervised.fail`)
 * closes the sandboxes, then reports `ended`. A cut-off reports `released` with its reason
 * first (shutdown, self-stop, ...), so the run is recovered within the platform's grace
 * period, then closes the sandboxes; the next claim resumes the queue. A stop by the server
 * or a lost lease reports nothing.
 * None of these stops writes a `thread.ended`: the threads are cut off, and the next claim
 * (which learns why from `claim.previousClaim`) resumes them (`run-loop.ts`). The exception
 * is a user's cancel, which the runner learns as `stop`: the API has already ended every
 * thread `cancelled` with the run, and an ended run is never claimed again.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { inputPrefix, referencePrefix, workflowSnapshotPrefix } from "@voluma/contracts/r2";
import type { Claim, ReportRequest } from "@voluma/contracts/runner";
import { runClient } from "@voluma/harness/adapters/http/run-client";
import { errorText } from "@voluma/harness/error-text";
import { type LiveBatcher, liveBatcher } from "@voluma/harness/live";
import {
  NO_WORKFLOW_DIR,
  roleModelUnset,
  runModelNotForVisitors,
  runModelUnavailable,
} from "@voluma/harness/messages";
import { usageOf } from "@voluma/harness/model-usage";
import type { CreateSandbox } from "@voluma/harness/ports/sandbox";
import { type Recorder, recorder } from "@voluma/harness/recorder";
import {
  type ModelSetup,
  type Outcome,
  type Prepared,
  pinnedImageOf,
  type Supervised,
  superviseRun,
} from "@voluma/harness/supervise-run";
import { TOOL_NAMES } from "@voluma/harness/tools";
import type { ObjectStore } from "@voluma/object-store";
import type { AgentDefinition } from "@voluma/workflow/definition";
import { loadWorkflow } from "@voluma/workflow/load";
import { computePlan } from "@voluma/workflow/plan";
import { type Config, isVisitorSafe, providerKey } from "./config.ts";
import { holdLease, type StopReason } from "./lease.ts";
import { eventLine } from "./log.ts";
import { metaImages } from "./meta-images.ts";
import { claimSandboxes, endOtherClaims, terminateClaim } from "./modal-sandbox.ts";
import { loggedFetch } from "./model-fetch.ts";
import { providerFailure } from "./provider-error.ts";
import { r2Outputs } from "./r2-outputs.ts";
import { type Redact, redactor } from "./redact.ts";
import { sandboxGateway } from "./sandbox-gateway.ts";
import { storeEvidence } from "./store-evidence.ts";
import { storeFiles } from "./store-files.ts";
import { heartbeatRoundTrip, inRunScope, type RunScope } from "./telemetry.ts";
import { assertThinking, nearestThinking } from "./thinking.ts";
import { withTransientRetry } from "./transient.ts";
import { usageMeter } from "./usage.ts";

/** The repo checkout this runner was deployed from: `workflows/` is read from it. */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
/**
 * How long closing the sandbox may take before Modal is asked to terminate the claim's by
 * tag. Terminating takes tens of seconds, so a normal end waits longer (the lease is held
 * meanwhile, and the `stopped` event needs the close to finish); after a stop, the run's
 * report waits only on the platform's grace period.
 */
const CLOSE_BUDGET_MS = { ended: 60_000, stopped: 15_000 };
/**
 * How long a shutdown release waits for its events and final usage to reach an API that may be
 * down before it reports. The report's retries then get what is left of the shutdown budget (`main.ts`): a
 * release that never reaches the server is recorded as `lease-expired`, unless a later claim
 * has not yet swept the lease (`takeBackStrike`, `pg-queue.ts`).
 */
const RELEASE_FLUSH_MS = 15_000;
/** How long an ended run waits for the review assets still being converted before it reports. */
const DRAIN_MS = 10 * 60_000;
/**
 * Pi's retries of a model call (408, 409, 429, 5xx, dropped connections) are the only ones: the
 * backoff doubles from 0.5 s to a cap of 8 s, so 10 retries cover about a minute of provider
 * trouble; a server asking for more than MODEL_MAX_RETRY_DELAY_MS fails the call at once.
 */
const MODEL_RETRIES = 10;
const MODEL_MAX_RETRY_DELAY_MS = 30_000;
/**
 * Time the provider gets to answer a request with its headers (the SDK clears the timer then,
 * so a streaming body is not cut). Meta sends them after prefill: 24.7 s at most, measured at
 * 805k tokens. A request that hangs before its headers is retried, so a dead endpoint holds a
 * call for up to 11 × 60 s plus the backoff.
 */
const MODEL_REQUEST_TIMEOUT_MS = 60_000;

export interface RunnerContext {
  config: Config;
  models: Models;
  /** The model behind each alias the config sets (`config.models`), resolved at startup. */
  aliases: Record<string, Model<Api>>;
  visitorModel: Model<Api>;
  /** The run's bucket. */
  objects: ObjectStore;
  log(line: string): void;
}

/** The R2 prefix of the run's scan: a reference scan or an upload. */
export const inputPrefixOf = (run: Claim["run"]) =>
  run.input.source === "reference" ? referencePrefix("scan") : inputPrefix(run.input.id);

type Stopped = StopReason | "shutdown";

/** The report of a claim that was cut off; undefined: say nothing more (the server or lease ended it). */
function cutOffReport(stopped: Stopped): ReportRequest["report"] | undefined {
  return stopped === "stop" || stopped === "lease-lost"
    ? undefined
    : { kind: "released", reason: stopped };
}

const endedReport = (error?: string): ReportRequest["report"] =>
  error === undefined
    ? { kind: "ended", outcome: "completed" }
    : { kind: "ended", outcome: "failed", error };

/** Runs the claim inside its `RunScope`, so an uncaught error in its work fails this run alone. */
export function runClaim(ctx: RunnerContext, claim: Claim, shutdown: AbortSignal): Promise<void> {
  const scope: RunScope = { runId: claim.run.id, log: () => {}, inFlight: new Map() };
  return inRunScope(scope, () => claimBody(ctx, claim, shutdown, scope));
}

async function claimBody(
  ctx: RunnerContext,
  claim: Claim,
  shutdown: AbortSignal,
  scope: RunScope,
): Promise<void> {
  const { config, models, objects } = ctx;
  const { run, leaseToken, keys } = claim;
  const runId = run.id;
  const claimId = randomUUID();
  const visitor = keys !== undefined;
  /** The key for a provider: a visitor's Meta key is good for Meta alone. */
  const keyFor = (provider: string) =>
    visitor ? (provider === "meta" ? keys.metaApiKey : undefined) : providerKey(provider);
  const redact: Redact = redactor([...config.secrets, ...(visitor ? [keys.metaApiKey] : [])]);
  const log = (line: string) => ctx.log(`[${runId}] ${redact(line)}`);
  /** The report keeps only `errorText`; the stack shows where an error came from. */
  const logStack = (e: unknown) => log(e instanceof Error && e.stack ? e.stack : String(e));
  scope.log = log;

  // The cut-off: the one signal the supervisor takes. Only a stop that will not end the run fires it.
  const cutOff = new AbortController();
  let stopped: Stopped | undefined;
  // Every reason is logged once, since a later one (an error) is what a self-stop would hide;
  // the first cut-off decides the report.
  const reasons = new Set<string>();
  const note = (reason: string) => {
    if (reasons.has(reason)) return;
    reasons.add(reason);
    log(`stop: ${reason}${reasons.size === 1 ? "" : ` (first was ${[...reasons][0]})`}`);
  };
  const stop = (reason: Stopped) => {
    stopped ??= reason;
    note(reason);
    cutOff.abort();
  };
  // The shutdown signal outlives this run: the listener is removed in `finally`.
  const onShutdown = () => stop("shutdown");
  shutdown.addEventListener("abort", onShutdown);
  if (shutdown.aborted) stop("shutdown");

  const meter = usageMeter();
  const client = runClient(
    config.api,
    { runId, leaseToken },
    {
      redact,
      onLeaseLost: () => stop("lease-lost"),
      runStopped: cutOff.signal,
      // Heartbeats answered during the failure window prove the API is up: the run is refused
      // those writes, not cut off from it, so the stop counts as a strike and a route that fails
      // for good ends the run instead of looping.
      onUnreachable: (firstFailureAt) =>
        stop((lease?.acknowledgedAt() ?? 0) > firstFailureAt ? "refused" : "self-stop"),
    },
  );
  let lease: ReturnType<typeof holdLease> | undefined;
  let events: Recorder | undefined;
  let live: LiveBatcher | undefined;
  let supervised: Supervised | undefined;
  let images: ReturnType<typeof metaImages> | undefined;
  let outcome: Outcome | undefined;
  let error: string | undefined;
  // An error nobody caught (`telemetry.ts`). Before the supervisor exists it fails the claim at
  // the next step; after, `Supervised.fail` ends the run with it.
  let uncaught: string | undefined;
  scope.fail = (e) => {
    if (cutOff.signal.aborted) return false; // released or stopped: nothing is reported as failed
    const message = redact(errorText(e));
    if (supervised) {
      if (!supervised.fail(message)) return false;
    } else uncaught ??= message;
    note("error");
    return true;
  };
  try {
    lease = holdLease({
      client,
      meter,
      onStop: stop,
      onRoundTrip: heartbeatRoundTrip,
      log,
    });
    log(`claimed (${visitor ? "visitor" : "voluma"} keys)`);

    // Metered from the start of creation (the sweep included) to destroy: a conservative upper bound.
    const modal = claimSandboxes(config, config.modal, claimId);
    const createSandbox: CreateSandbox = async (spec, signal) => {
      meter.sandboxUp();
      try {
        const sandbox = await modal(spec, signal);
        return {
          exec: (request, s) => sandbox.exec(request, s),
          writeFile: (path, bytes, s) => sandbox.writeFile(path, bytes, s),
          exitCode: () => sandbox.exitCode(),
          destroy: () => sandbox.destroy().finally(() => meter.sandboxDown()),
        };
      } catch (e) {
        meter.sandboxDown();
        throw e;
      }
    };
    // A thread's name for a log line, from its `thread.started` (recorded before any other event of the thread).
    const names = new Map<string, string>();
    const nameOf = (id: string) => names.get(id) ?? id;
    const stored = await client.storedEvents();
    // The image the run began on: a deploy that changes `SANDBOX_IMAGE` must not move a resumed
    // run to different dependencies. A run made before this was recorded is refused here.
    const pinnedImage = pinnedImageOf(runId, stored);
    const sandboxImage = pinnedImage ?? config.sandbox.image;
    log(`sandbox image: ${sandboxImage} (${pinnedImage ? "the run's own" : "this runner's"})`);
    live = liveBatcher((frames) => client.live(frames));
    const recorded = recorder(
      {
        async append(event) {
          await client.append(event);
          log(eventLine(event, redact, nameOf));
        },
      },
      runId,
      () => stop("lease-lost"),
      stored,
      live,
    );
    // The in-flight tool calls (`telemetry.ts`) follow the events as they are emitted, not as
    // the queue delivers them: a stall must name the call that caused it.
    const track = (threadId: string, type: string, payload: unknown) => {
      if (type === "thread.started") names.set(threadId, (payload as { name: string }).name);
      const { toolCallId, name } = payload as { toolCallId: string; name?: string };
      if (type === "tool.call") scope.inFlight.set(toolCallId, `${nameOf(threadId)} ${name}`);
      else if (type === "tool.result") scope.inFlight.delete(toolCallId);
    };
    events = {
      ...recorded,
      emit(threadId, type, payload, id) {
        track(threadId, type, payload);
        recorded.emit(threadId, type, payload, id);
      },
      append(threadId, type, payload, id) {
        track(threadId, type, payload);
        return recorded.append(threadId, type, payload, id);
      },
    };
    const streamFor =
      (role: string): ModelSetup["streamFn"] =>
      (m, context, options) => {
        // `sessionId` is the thread's id, for a turn and for a compaction summary.
        const threadId = options?.sessionId as string;
        const apiKey = keyFor(m.provider);
        const fetch = loggedFetch(role, log, options?.signal);
        // Meta requests name each image by an uploaded file id, not its bytes (`meta-images.ts`).
        if (m.provider === "meta" && apiKey) images ??= metaImages(m.baseUrl, apiKey, log);
        const call = m.provider === "meta" ? images?.forCall(fetch, options?.signal) : undefined;
        const stream = models.streamSimple(m, context, {
          ...options,
          apiKey,
          maxRetries: MODEL_RETRIES,
          maxRetryDelayMs: MODEL_MAX_RETRY_DELAY_MS,
          timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
          fetch: call?.fetch ?? fetch,
          ...(call && { onPayload: call.onPayload }),
          // All registered providers await this before normalizing each event. An async
          // iterator alone can drain buffered deltas entirely through microtasks, starving
          // lease timers.
          onProviderStreamEvent: async (event, model) => {
            await options?.onProviderStreamEvent?.(event, model);
            await setImmediate();
          },
          // Meta's default prompt cache is in-memory and evicted under pressure or after
          // inactivity. Runs have long tool calls and many independent threads, so ask the
          // Responses API to keep Meta prefixes for up to 24 hours. Anthropic long retention
          // costs more per cache write, so leave its existing setting unchanged.
          ...(m.provider === "meta" && { cacheRetention: "long" }),
        });
        stream.result().then(
          (reply) => meter.addModelCall(role, threadId, usageOf(reply)),
          () => {},
        );
        return stream;
      };
    const prepare = async (signal: AbortSignal): Promise<Prepared> => {
      // What an earlier claim of this run left running must not keep writing or spending, so this
      // claim starts no sandbox (and restores nothing) until Modal reports each one terminated.
      const orphans = await endOtherClaims(config.modal, runId, claimId, signal, log);
      if (orphans > 0)
        log(`ended ${orphans} sandbox${orphans === 1 ? "" : "es"} of an earlier claim`);

      // Before any sandbox: an unreadable workflow or a bad selection fails the run here, with its
      // message. The run's pin names the workflow directory; its files are snapshotted from this
      // runner's checkout once (at `config.commit`), so a resume reads what the run began with.
      const workflowDir = run.workflows[0]?.path;
      if (!workflowDir) throw new Error(NO_WORKFLOW_DIR);
      const definition = await withTransientRetry("loading the workflow", signal, log, () =>
        loadWorkflow(workflowDir, {
          store: objects,
          prefix: workflowSnapshotPrefix(runId),
          root: REPO_ROOT,
          commit: config.commit,
          knownTools: TOOL_NAMES,
        }),
      );
      // The model every role uses: `RUNNER_MODEL` (a plumbing check) over the run's own model
      // (`run.model`, chosen by the API) over the role file's alias. A run without one predates
      // the choice. A visitor's key and scan go to Standard-mode Meta models only, whatever the
      // API recorded, so a run that asks for another fails here and says which.
      const runModel = (): Model<Api> | undefined => {
        if (!run.model || config.modelForced) return undefined;
        const [provider = "", ...id] = run.model.split("/");
        if (visitor && !isVisitorSafe({ provider, id: id.join("/") })) {
          log(`the visitor run's model ${run.model} is not a Standard-mode Meta model`);
          throw new Error(runModelNotForVisitors(run.model));
        }
        const model = models.getModel(provider, id.join("/"));
        if (!model || !keyFor(provider)) {
          log(
            `the run's model ${run.model} is unknown here or has no key: VOLUMA_${provider.toUpperCase()}_API_KEY`,
          );
          throw new Error(runModelUnavailable(run.model));
        }
        return model;
      };
      const chosen = runModel();
      // Without a run model, a role's model is its file's alias; a visitor's main thread keeps
      // it when that is Standard-mode Meta, else the visitor model.
      const roleModel = ({ name, model: alias }: AgentDefinition) => {
        if (chosen) return chosen;
        const model = ctx.aliases[alias];
        if (!model) {
          log(
            `the ${name} role's model "${alias}" is unset: set RUNNER_MODEL_${alias.toUpperCase()}`,
          );
          throw new Error(roleModelUnset(alias));
        }
        return !visitor || (name === "main" && isVisitorSafe(model)) ? model : ctx.visitorModel;
      };
      // A role's file may set its thinking level; else the runner's; else none is sent ("off").
      // The run's model gets the nearest level it supports (DeepSeek Flash has no `medium`).
      const roleThinking = ({ name, thinking }: AgentDefinition, model: Model<Api>) => {
        if (visitor) return "off";
        const wanted = config.modelForced ? config.thinking : (thinking ?? config.thinking);
        const level = chosen ? nearestThinking(wanted, model) : wanted;
        assertThinking(level, [model], `the ${name} role's`);
        return level ?? "off";
      };
      const roles = Object.values(definition.agents);
      const setups = new Map(
        roles.map((r) => {
          const model = roleModel(r);
          return [r.name, { model, thinkingLevel: roleThinking(r, model) }] as const;
        }),
      );
      const setupOf = (name: string) => {
        const setup = setups.get(name);
        if (!setup) throw new Error(`${name} is not a role of this run`);
        return setup;
      };
      log(`models: ${roles.map((r) => `${r.name} ${setupOf(r.name).model.id}`).join(", ")}`);
      log(`thinking: ${roles.map((r) => `${r.name} ${setupOf(r.name).thinkingLevel}`).join(", ")}`);
      // A thread keeps the model it started on (the log records it).
      const threadModel = (fallback: Model<Api>, recorded: string | undefined) => {
        if (recorded) {
          // Only a model this run may use: a visitor's scan goes to Standard-mode Meta only. Any other
          // thread (a run made on another model, reopened for a correction) gets the role's model:
          // its stored history was written by another, so it is refused as unresumable and the run
          // loop starts the work again (`run-loop.ts`), instead of the run failing.
          const [provider = "", ...id] = recorded.split("/");
          const allowed = visitor
            ? isVisitorSafe({ provider, id: id.join("/") })
            : [...setups.values()].some(({ model: m }) => `${m.provider}/${m.id}` === recorded);
          return (allowed && models.getModel(provider, id.join("/"))) || fallback;
        }
        return fallback;
      };
      return {
        definition,
        plan: computePlan(definition.files, run.selectedOutputs).tasks,
        model: (role, recorded) => ({
          model: threadModel(setupOf(role).model, recorded),
          thinkingLevel: setupOf(role).thinkingLevel,
          streamFn: streamFor(role),
        }),
      };
    };
    supervised = superviseRun({
      runId,
      prepare: (signal) =>
        prepare(signal).catch((e) => {
          logStack(e);
          throw e;
        }),
      selectedOutputs: run.selectedOutputs,
      notes: run.notes,
      inputId: run.input.id,
      inputPrefix: inputPrefixOf(run),
      previousClaim: claim.previousClaim?.reason,
      providerError: providerFailure,
      workflows: run.workflows,
      recorder: events,
      history: client,
      evidence: storeEvidence(objects),
      files: storeFiles(objects),
      outputs: r2Outputs(config.r2),
      createSandbox,
      // The image is recorded on the root's first event, so `sandboxImage` is the run's own.
      sandbox: { ...config.sandbox, image: sandboxImage },
      // The token follows the tool grant: `superviseRun` asks for it only for a sandbox whose role holds `segment_sam`.
      gateway: config.gateway
        ? (sandbox) =>
            sandboxGateway(
              config,
              { runId, leaseToken, visitorMetaKey: keys?.metaApiKey },
              sandbox,
              redact,
            )
        : undefined,
      config: config.loop,
      log,
      drainMs: DRAIN_MS,
      signal: cutOff.signal,
    });
    // An error nobody caught before the supervisor existed ends the run like one after it.
    if (uncaught !== undefined) supervised.fail(uncaught);
    outcome = await supervised.result;
    if (outcome.kind === "ended" && outcome.error !== undefined)
      log(`failed: ${redact(outcome.error)}`);
  } catch (e) {
    error = redact(errorText(e));
    log(`failed: ${error}`);
    logStack(e);
  } finally {
    // The harness decided how the claim ended, drained included; a stop landing now changes nothing.
    // Without an outcome the claim failed before the supervisor ran (or was stopped then).
    const report =
      outcome?.kind === "ended"
        ? endedReport(outcome.error === undefined ? undefined : redact(outcome.error))
        : stopped
          ? cutOffReport(stopped)
          : endedReport(uncaught ?? error);
    if (report?.kind === "ended") await closeSandboxes(CLOSE_BUDGET_MS.ended);
    shutdown.removeEventListener("abort", onShutdown);
    lease?.halt();
    const wrapUp = (async () => {
      await live?.flush();
      await events?.flush();
      if (report) await lease?.sendFinalUsage();
    })();
    await untilShutdownPlus(RELEASE_FLUSH_MS, wrapUp);
    if (report) {
      const stored = await client.report(report).catch((e) => {
        log(`report failed: ${e instanceof Error ? e.message : e}`);
        return undefined;
      });
      if (stored === false)
        log(
          `${report.kind === "released" ? "release" : "end"} not stored: the server answered 409 (the run ended first or the lease is gone); ${
            report.kind === "released" ? `reason ${report.reason}` : `outcome ${report.outcome}`
          }`,
        );
      else if (stored)
        log(`reported ${report.kind}${report.kind === "ended" ? ` ${report.outcome}` : ""}`);
      if (live) {
        const { frames, requests, dropped } = live.stats();
        log(`live frames this claim: ${frames} in ${requests} requests, ${dropped} dropped`);
      }
      log(`model cost this claim: $${meter.totalModelCostUsd().toFixed(4)}`);
      for (const line of meter.cacheSummary()) log(`model usage this claim, ${line}`);
      if (images) log(`model requests this claim: ${images.summary()}`);
    } else {
      log(`stopped (${[...reasons].join(", ")}); nothing more to report`);
    }
    if (report?.kind !== "ended") {
      await closeSandboxes(CLOSE_BUDGET_MS.stopped);
    }
  }

  /**
   * Waits for `work`, but gives up `ms` after the shutdown signal fires (or at once plus `ms`
   * when it already has): the process exits when the shutdown budget (`main.ts`) is spent, so a
   * report or a close under shutdown must fit in what is left. Undefined when it gave up.
   */
  async function untilShutdownPlus<T>(ms: number, work: Promise<T>): Promise<T | undefined> {
    const done = new AbortController();
    const late = new Promise<undefined>((resolve) => {
      const arm = () => {
        const timer = setTimeout(resolve, ms, undefined);
        done.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      };
      if (shutdown.aborted) arm();
      else shutdown.addEventListener("abort", arm, { once: true, signal: done.signal });
    });
    try {
      return await Promise.race([work, late]);
    } finally {
      done.abort();
    }
  }

  async function closeSandboxes(budgetMs: number) {
    if (!supervised) return;
    const closed = supervised.close().then(
      () => true,
      () => false,
    );
    const timeout = new Promise<false>((resolve) => setTimeout(resolve, budgetMs, false));
    // A shutdown during the close switches to the stopped budget.
    if (!(await untilShutdownPlus(CLOSE_BUDGET_MS.stopped, Promise.race([closed, timeout])))) {
      log("sandbox did not close in time; terminating this claim's sandboxes");
      await terminateClaim(config.modal, runId, claimId).catch((e) =>
        log(`terminate failed: ${e}`),
      );
    }
  }
}
