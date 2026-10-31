/**
 * One claimed run, start to report: the same path for a fresh run and a recovered one. It
 * reads the run's stored events over HTTP, builds the recorder on them and the sandbox
 * session (one sandbox per thread), and hands the harness its adapters (`superviseRun`). Alongside, it holds the lease
 * (`lease.ts`) and stops at once on any of: the server ending the run, a lost lease, a
 * self-stop, or the service shutting down. Then it reports.
 *
 * A visitor run uses the claim's Meta key for the model, held in this function's
 * scope only. Everything that leaves the process goes through the run's `redact`: the
 * run client (`runClient`) redacts what it sends, the console line is redacted before it is
 * clipped. The function never rejects: every failure after `redact` exists is caught and
 * logged through it.
 *
 * Beside the supervisor runs the conversion worker (`@voluma/harness/review-assets`): it turns
 * the files tasks report into review assets in a `convert` sandbox as they appear. It stops when a stop will
 * not end the run, not on the internal abort at the end of the run, which it must outlive.
 *
 * End of the run, in order. A normal end (an uncaught error included) waits for
 * the conversion queue to drain (bounded by `DRAIN_MS`, the lease heartbeating meanwhile; every
 * output left without an `assets.*` event is recorded as failed; a stop during the wait ends it
 * and the run is released instead), then closes the sandboxes, then reports. A stop
 * (shutdown, self-stop) reports `released` with its reason first, so the run is recovered within
 * the platform's grace period, then closes the sandboxes; it does not drain, the next claim
 * resumes the queue. A stop by the server or a lost lease reports nothing.
 * None of these stops writes a `thread.ended`: the threads are cut off, and the next claim
 * (which learns why from `claim.previousClaim`) resumes them (`run-loop.ts`). The exception
 * is a user's cancel, which the runner learns as `stop`: the API has already ended every
 * thread `cancelled` with the run, and an ended run is never claimed again.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { inputPrefix, referencePrefix, workflowSnapshotPrefix } from "@voluma/contracts/r2";
import type { Claim, ReportRequest } from "@voluma/contracts/runner";
import { runClient } from "@voluma/harness/adapters/http/run-client";
import { type RunLayout, runLayout, type ThreadLayout } from "@voluma/harness/layout";
import { type LiveBatcher, liveBatcher } from "@voluma/harness/live";
import { usageOf } from "@voluma/harness/model-usage";
import { type Recorder, recorder } from "@voluma/harness/recorder";
import {
  convertMounts,
  type ReviewAssetsWorker,
  reviewAssetsWorker,
} from "@voluma/harness/review-assets";
import { type SandboxSession, sandboxSession } from "@voluma/harness/sandbox-session";
import {
  checkSandboxSpec,
  convertSandboxSpec,
  workerSandboxSpec,
} from "@voluma/harness/sandbox-specs";
import {
  type RoleOf,
  type RoleSetup,
  rootThreadIdOf,
  superviseRun,
} from "@voluma/harness/supervise-run";
import { TOOL_NAMES } from "@voluma/harness/tools";
import type { ObjectStore } from "@voluma/object-store";
import type { Skill } from "@voluma/workflow/definition";
import { loadWorkflow } from "@voluma/workflow/load";
import { computePlan } from "@voluma/workflow/plan";
import { type Config, isVisitorSafe, providerKey } from "./config.ts";
import { holdLease, type StopReason } from "./lease.ts";
import { eventLine } from "./log.ts";
import { claimSandboxes, endOtherClaims, terminateClaim } from "./modal-sandbox.ts";
import { retryTransient } from "./model-retry.ts";
import {
  checkPrompt,
  mainPrompt,
  mainRestartPrompt,
  systemPrompt,
  workerPrompt,
} from "./prompts.ts";
import { providerFailure } from "./provider-error.ts";
import { r2Outputs } from "./r2-outputs.ts";
import { type Redact, redactor } from "./redact.ts";
import { sandboxGateway } from "./sandbox-gateway.ts";
import { storeEvidence } from "./store-evidence.ts";
import { storeFiles } from "./store-files.ts";
import { heartbeatRoundTrip, inRunScope, type RunScope } from "./telemetry.ts";
import { assertThinking } from "./thinking.ts";
import { type ModelRole, usageMeter } from "./usage.ts";

/** The repo checkout this runner was deployed from: `workflows/` is read from it. */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
/**
 * How long closing the sandbox may take before Modal is asked to terminate the claim's by
 * tag. Terminating takes tens of seconds, so a normal end waits longer (the lease is held
 * meanwhile, and the `stopped` event needs the close to finish); after a stop, the run's
 * report waits only on the platform's grace period.
 */
const CLOSE_BUDGET_MS = { ended: 60_000, stopped: 15_000 };
/** How long threads get to end after a stop before the run is reported anyway. */
const WIND_DOWN_MS = 5_000;
/**
 * How long a shutdown release waits for its events and final usage to reach an API that may be
 * down before it reports. The report's retries then get what is left of the shutdown budget (`main.ts`): a
 * release that never reaches the server is recorded as `lease-expired`, unless a later claim
 * has not yet swept the lease (`takeBackStrike`, `pg-queue.ts`).
 */
const RELEASE_FLUSH_MS = 15_000;
/** How long an ended run waits for the review assets still being converted before it reports. */
const DRAIN_MS = 10 * 60_000;
/** Pi's own retries of a model call (429 honours retry-after, 5xx, dropped connections). */
const MODEL_RETRIES = 3;

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

/** Where a run's files are: its scan (a reference scan or an upload), outputs and scratch. */
export const layoutOf = (
  run: Claim["run"],
  skills: readonly Skill[],
  mainWorks: boolean,
  copiesInputs: (taskId: string) => boolean,
) =>
  runLayout(
    run.id,
    run.input.source === "reference" ? referencePrefix("scan") : inputPrefix(run.input.id),
    skills,
    mainWorks,
    copiesInputs,
  );

/** "error": an error nobody caught reached the process handler while this run was working (`telemetry.ts`). */
type Stopped = StopReason | "shutdown" | "error";

/** Which report a stop reason, a clean end or a failure becomes; undefined: say nothing more. */
export function reportFor(
  stopped: Stopped | undefined,
  error?: string,
): ReportRequest["report"] | undefined {
  if (stopped === "stop" || stopped === "lease-lost") return undefined;
  if (
    stopped === "self-stop" ||
    stopped === "loop-stalled" ||
    stopped === "refused" ||
    stopped === "shutdown"
  )
    return { kind: "released", reason: stopped };
  return error === undefined
    ? { kind: "ended", outcome: "completed" }
    : { kind: "ended", outcome: "failed", error };
}

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
  scope.log = log;

  const abort = new AbortController();
  // The conversion worker's own signal: it ends when a stop will not end the run, not with the
  // abort `finally` does to close it. `haltedBy` is the stop that did.
  const halt = new AbortController();
  let haltedBy: Stopped | undefined;
  // An object, so TypeScript does not narrow what the callbacks set.
  const why: { stopped?: Stopped } = {};
  // The first reason decides the report; every reason is logged, since a later one (an
  // error) is what a self-stop would otherwise hide.
  const reasons = new Set<Stopped>();
  const stop = (reason: Stopped) => {
    why.stopped ??= reason;
    if (reportFor(reason)?.kind !== "ended") {
      haltedBy ??= reason;
      halt.abort();
    }
    if (!reasons.has(reason)) {
      reasons.add(reason);
      log(`stop: ${reason}${reason === why.stopped ? "" : ` (first was ${why.stopped})`}`);
    }
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
  let live: LiveBatcher | undefined;
  let session: SandboxSession | undefined;
  let convert: ReviewAssetsWorker | undefined;
  let error: string | undefined;
  // An error nobody caught (`telemetry.ts`) is kept apart from `error`, so a later throw does
  // not replace it. Once `finally` fixes the report it can change nothing.
  let uncaught: string | undefined;
  let reportFixed = false;
  scope.fail = (e) => {
    if (reportFixed) return false;
    uncaught ??= redact(e instanceof Error ? e.message : String(e));
    stop("error");
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

    // What an earlier claim of this run left running must not keep writing or spending, so this
    // claim starts no sandbox (and restores nothing) until Modal reports each one terminated.
    const orphans = await endOtherClaims(config.modal, runId, claimId, abort.signal, log);
    if (orphans > 0)
      log(`ended ${orphans} sandbox${orphans === 1 ? "" : "es"} of an earlier claim`);

    // Before any sandbox: an unreadable workflow or a bad selection fails the run here, with its
    // message. The run's pin names the workflow directory; its files are snapshotted from this
    // runner's checkout once (at `config.commit`), so a resume reads what the run began with.
    const workflowDir = run.workflows[0]?.path;
    if (!workflowDir) throw new Error("the run pins no workflow directory");
    const definition = await loadWorkflow(workflowDir, {
      store: objects,
      prefix: workflowSnapshotPrefix(runId),
      root: REPO_ROOT,
      commit: config.commit,
      knownTools: TOOL_NAMES,
    });
    // A role's model is its file's alias. A visitor's key and scan go to Standard-mode Meta
    // models only: the main thread keeps its configured model when that is one, else the
    // visitor model.
    const roleModel = (role: ModelRole) => {
      const alias = definition.agents[role].model;
      const model = ctx.aliases[alias];
      if (!model)
        throw new Error(
          `the ${role} role names model "${alias}", which RUNNER_MODEL_${alias.toUpperCase()} does not set`,
        );
      return !visitor || (role === "main" && isVisitorSafe(model)) ? model : ctx.visitorModel;
    };
    // A role's file may set its thinking level; else the runner's; else none is sent ("off").
    const roleThinking = (role: ModelRole, model: Model<Api>) => {
      if (visitor) return "off";
      const level = config.modelForced
        ? config.thinking
        : (definition.agents[role].thinking ?? config.thinking);
      assertThinking(level, [model], `the ${role} role's`);
      return level ?? "off";
    };
    const workerModel = roleModel("worker");
    const checkModel = roleModel("check");
    const mainModel = roleModel("main");
    const thinking = {
      worker: roleThinking("worker", workerModel),
      check: roleThinking("check", checkModel),
      main: roleThinking("main", mainModel),
    };
    log(`models: worker ${workerModel.id}, check ${checkModel.id}, main ${mainModel.id}`);
    log(`thinking: worker ${thinking.worker}, check ${thinking.check}, main ${thinking.main}`);
    // The tasks that produce the selected outputs and what they need. The main thread may adapt
    // them to the run's notes when the run starts (`superviseRun`).
    const computed = computePlan(definition.files, run.selectedOutputs);
    // Each role gets the tools its file lists. `segment_sam` also needs the gateway, and a
    // sandbox to run in: workers have one, main only when its role holds `bash`; the checker
    // never holds it (it does not redo the task).
    const grant = (role: ModelRole) => {
      const { tools } = definition.agents[role];
      const sandboxed = role === "worker" || (role === "main" && tools.includes("bash"));
      return tools.filter((t) => t !== "segment_sam" || (config.gateway && sandboxed));
    };

    // From the workflow's task, so a task the main agent adds from it keeps the flag.
    const copyInputs = new Set(definition.files.tasks.filter((t) => t.copyInputs).map((t) => t.id));
    const plain = layoutOf(run, definition.skills, grant("main").includes("bash"), (id) =>
      copyInputs.has(id),
    );
    // The run loop lays a thread out before it uses its sandbox or writes its first line; the
    // sandbox and the log, which know a thread only by id, look its layout up here.
    const laidOut = new Map<string, ThreadLayout>();
    const layout: RunLayout = {
      ...plain,
      forThread(thread, cited) {
        const laid = plain.forThread(thread, cited);
        laidOut.set(thread.id, laid);
        return laid;
      },
    };
    const laid = (threadId: string) => {
      const found = laidOut.get(threadId);
      if (!found) throw new Error(`${threadId} was never laid out`);
      return found;
    };
    // A thread's name for a line: the root thread is never laid out.
    const nameOf = (threadId: string) => laidOut.get(threadId)?.name ?? threadId;
    const createSandbox = claimSandboxes(config, config.modal, claimId);
    const stored = await client.storedEvents();
    // The image the run began on: a deploy that changes `SANDBOX_IMAGE` must not move a resumed
    // run to different dependencies. A run recorded before the field existed takes this runner's.
    const pinnedImage = stored
      .flatMap((e) =>
        e.type === "thread.started" && e.threadId === rootThreadIdOf(runId)
          ? [e.payload.sandboxImage]
          : [],
      )
      .find((image) => image !== undefined);
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
      (reason) => stop(reason === "lease-lost" ? "lease-lost" : "self-stop"),
      undefined,
      stored,
      live,
      halt.signal,
    );
    // The in-flight tool calls (`telemetry.ts`) follow the events as they are emitted, not as
    // the queue delivers them: a stall must name the call that caused it.
    const track = (threadId: string, type: string, payload: unknown) => {
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
    session = sandboxSession(
      (threadId) => {
        const thread = laid(threadId);
        const common = {
          runId,
          name: thread.name,
          image: sandboxImage,
          lifetimeSeconds: config.sandbox.lifetimeSeconds,
          idleSeconds: config.sandbox.idleSeconds,
          env: thread.env,
          workdir: thread.dir,
        };
        return createSandbox(
          thread.role === "worker" ||
            thread.mounts.some((m) => m.path === "/outputs" && m.access === "read-write")
            ? workerSandboxSpec({
                ...common,
                mounts: thread.mounts,
                // The network and the token follow the tool grant: a sandbox whose role cannot
                // call `segment_sam` gets neither, since `voluma-sam` is on every sandbox's PATH.
                gateway: grant(thread.role).includes("segment_sam")
                  ? sandboxGateway(
                      config,
                      { runId, leaseToken, visitorMetaKey: keys?.metaApiKey },
                      thread.name,
                      redact,
                    )
                  : undefined,
              })
            : checkSandboxSpec({
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
        events?.emit(id, "sandbox", { name: laid(id).name, state, detail });
      },
      (threadId) => laid(threadId).restartNote,
    );
    const opened = session;

    // A thread keeps the model it started on (the log records it).
    const threadModel = (primary: Model<Api>, recorded: string | undefined) => {
      if (recorded) {
        // Only a model this run may use: a visitor's scan goes to Standard-mode Meta only. Any other
        // thread (a run made on another model, reopened for a correction) gets the role's model:
        // its stored history was written by another, so it is refused as unresumable and the run
        // loop starts the work again (`run-loop.ts`), instead of the run failing.
        const [provider = "", ...id] = recorded.split("/");
        const allowed = visitor
          ? isVisitorSafe({ provider, id: id.join("/") })
          : [workerModel, checkModel, mainModel].some((m) => `${m.provider}/${m.id}` === recorded);
        return (allowed && models.getModel(provider, id.join("/"))) || primary;
      }
      return primary;
    };
    const callModel = (role: ModelRole) =>
      retryTransient(
        (m, context, options) =>
          models.streamSimple(m, context, {
            ...options,
            apiKey: keyFor(m.provider),
            maxRetries: MODEL_RETRIES,
          }),
        (attempt, delayMs, error) => {
          log(
            `${role} model call failed (${error}); retry ${attempt} in ${Math.round(delayMs / 1000)}s`,
          );
        },
      );
    const streamFor =
      (role: ModelRole): RoleSetup["streamFn"] =>
      (m, context, options) => {
        const stream = callModel(role)(m, context, options);
        stream.result().then(
          (reply) => meter.addModelCall(role, usageOf(reply)),
          () => {},
        );
        return stream;
      };
    const role =
      (primary: Model<Api>, modelRole: ModelRole): RoleOf =>
      (thread, recorded) => ({
        model: threadModel(primary, recorded),
        thinkingLevel: thinking[modelRole],
        streamFn: streamFor(modelRole),
        systemPrompt: systemPrompt(definition, thread),
        tools: grant(modelRole),
      });
    const files = storeFiles(objects);
    const supervised = superviseRun({
      runId,
      plan: computed.tasks,
      previousClaim: claim.previousClaim?.reason,
      providerError: providerFailure,
      workflow: definition.files,
      // The commit the files came from: the snapshot's, which a resume keeps.
      workflows: run.workflows.map((pin) => ({ ...pin, commit: definition.commit })),
      sandboxImage,
      layout,
      recorder: events,
      history: client,
      sandbox: (id, options) => opened.get(id, options),
      releaseSandbox: (id) =>
        opened.release(id).catch((e) => log(`releasing ${nameOf(id)} failed: ${e}`)),
      evidence: storeEvidence(objects),
      files,
      outputs: r2Outputs(config.r2),
      roles: {
        main: role(mainModel, "main"),
        worker: role(workerModel, "worker"),
        check: role(checkModel, "check"),
      },
      briefs: {
        main: (view) => mainPrompt(view, run.selectedOutputs, definition.files, run.notes),
        mainRestart: (view, state) =>
          mainRestartPrompt(view, state, run.selectedOutputs, definition.files, run.notes),
        worker: (task, brief) => workerPrompt(task, brief, run.notes),
        check: (task, state) => checkPrompt(task, state, run.notes),
      },
      config: config.loop,
      signal: abort.signal,
    });
    convert = reviewAssetsWorker({
      runId,
      rootThreadId: rootThreadIdOf(runId),
      recorder: events,
      signal: halt.signal,
      log,
      async createSandbox(signal) {
        // Metered like the run's sandboxes: from the start of creation to destroy.
        meter.sandboxUp();
        try {
          const sandbox = await createSandbox(
            convertSandboxSpec({
              runId,
              name: "convert",
              image: sandboxImage,
              lifetimeSeconds: config.sandbox.lifetimeSeconds,
              idleSeconds: config.sandbox.idleSeconds,
              // The converter imports `sidecar` through the run's PYTHONPATH.
              env: { PYTHONPATH: layout.pythonPath },
              ...convertMounts(runId),
            }),
            signal,
          );
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
      },
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
    // Frozen here: a stop that lands while the run is being closed does not change its report,
    // except during the drain below, where the queue is unfinished.
    const stopped = why.stopped;
    reportFixed = true;
    let report = reportFor(stopped, uncaught ?? error);
    abort.abort();
    if (report?.kind === "ended") {
      // Every output gets an `assets.*` event, or the run is released to be resumed.
      await convert?.drain(DRAIN_MS);
      // A stop during the drain ends it at once: the run is released (nothing, for a server stop
      // or a lost lease), so the next claim resumes the queue.
      if (haltedBy) report = reportFor(haltedBy);
      if (report?.kind === "ended") {
        await Promise.all([
          closeSandbox(CLOSE_BUDGET_MS.ended, session?.close.bind(session)),
          closeSandbox(CLOSE_BUDGET_MS.ended, convert?.close.bind(convert)),
        ]);
      }
    }
    shutdown.removeEventListener("abort", onShutdown);
    lease?.halt();
    const wrapUp = (async () => {
      await live?.flush();
      await events?.flush();
      if (report) await lease?.sendFinalUsage();
    })();
    await (report?.kind === "released" && report.reason === "shutdown"
      ? Promise.race([wrapUp, delay(RELEASE_FLUSH_MS)])
      : wrapUp);
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
    } else {
      log(`stopped (${[...reasons].join(", ")}); nothing more to report`);
    }
    if (report?.kind !== "ended") {
      await Promise.all([
        closeSandbox(CLOSE_BUDGET_MS.stopped, session?.close.bind(session)),
        closeSandbox(CLOSE_BUDGET_MS.stopped, convert?.close.bind(convert)),
      ]);
    }
  }

  async function closeSandbox(budgetMs: number, close: (() => Promise<void>) | undefined) {
    if (!close) return;
    const closed = close().then(
      () => true,
      () => false,
    );
    const timeout = new Promise<false>((resolve) => setTimeout(resolve, budgetMs, false));
    if (!(await Promise.race([closed, timeout]))) {
      log("sandbox did not close in time; terminating this claim's sandboxes");
      await terminateClaim(config.modal, runId, claimId).catch((e) =>
        log(`terminate failed: ${e}`),
      );
    }
  }
}
