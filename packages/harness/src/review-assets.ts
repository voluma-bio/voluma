/**
 * The conversion worker: turns every file a task reports as a volume, a structure mask or a
 * surface into review assets (`workflows/core/convert/review_assets.py`: OME-Zarr levels and
 * meshes) while the run is live, and records `assets.ready` or `assets.failed` for it on the
 * run's root thread. Review fetches the files by `reviewAssetKey`.
 *
 * Queue: every `output` event in the recorder's view, from the first (a resume reads the whole
 * log), minus the files that already have an `assets.*` event; new
 * outputs join as the recorder stores them (polled, one cheap scan of the new events). One file at a
 * time, in one `convert` sandbox per claim, created at the first file. A conversion that
 * fails is recorded and the worker moves on; one whose sandbox dies (or cannot be created) is
 * run once more on a new sandbox. Identity never comes from the converter's output: the
 * `sourceSha256` is the queue item's, and a converter that prints another one has failed.
 *
 * `signal` ends the worker (a stop, a lost lease, shutdown); it records nothing then, and the
 * next claim finds the unfinished files again. `drain` is for a run that has ended: it waits
 * for the queue, up to a bound, and leaves no output without an event (failed is permanent
 * for the run). Events go through `recorder.emit` (retried, ids fixed by the file's sha), and a
 * file counts as done only once its event is stored.
 */

import { ASSET_ERROR_MAX, type RunEvent } from "@voluma/contracts/events";
import { evidencePrefix, reviewAssetPrefix, workflowSnapshotPrefix } from "@voluma/contracts/r2";
import { type ReviewAssetsManifest, reviewAssetsManifestSchema } from "@voluma/contracts/review";
import { type Sandbox, SandboxEndedError, type SandboxMount } from "./ports/sandbox";
import type { Recorder } from "./recorder";
import { supervisorThreadId } from "./thread-id";

const EVIDENCE = "/evidence";
const WORKFLOW = "/workflow";
const REVIEW = "/review";
/** One conversion; a 1.25 GB scan is minutes. The drain bounds the end of the run, not this. */
const CONVERT_TIMEOUT_SECONDS = 1200;
const POLL_MS = 1000;
/** How long `drain` waits for a halted loop (a sandbox call that ignores abort) before it moves on. */
const HALT_GRACE_MS = 5000;

/** The mounts of the run's convert sandbox, for `convertSandboxSpec`. */
export function convertMounts(runId: string): {
  evidence: SandboxMount[];
  review: SandboxMount[];
} {
  return {
    evidence: [
      { path: EVIDENCE, prefix: evidencePrefix(runId), access: "read-only" },
      { path: WORKFLOW, prefix: workflowSnapshotPrefix(runId), access: "read-only" },
    ],
    review: [{ path: REVIEW, prefix: reviewAssetPrefix(runId), access: "read-write" }],
  };
}

interface Job {
  sha256: string;
  /** The converter's flags after `--source`. */
  flags: string;
}

/** The conversion an `output` event asks for; undefined for a kind with no review assets. */
export function convertJob(event: RunEvent): Job | undefined {
  if (event.type !== "output") return undefined;
  const { output } = event.payload;
  switch (output.kind) {
    case "volume": {
      const { kind, dtype, unit, file } = output.volume;
      // The scan's HU are float32 on disk; the viewer loads int16.
      const int16 = kind === "image" && dtype === "float32" && unit === "HU" ? " --int16" : "";
      return { sha256: file.sha256, flags: `--as ${kind}${int16}` };
    }
    case "structure":
      return "mask" in output.structure
        ? { sha256: output.structure.mask.sha256, flags: "--as mask" }
        : undefined;
    case "surface":
      return {
        sha256: output.surface.heights.sha256,
        flags: `--as surface --axis ${output.surface.axis}`,
      };
    default:
      return undefined;
  }
}

export interface ReviewAssetsWorker {
  /**
   * For a run that has ended: waits until every output has an `assets.*` event, up to
   * `timeoutMs`, then stops the worker and stores `assets.failed` for each output still without
   * one ("timed out", or "the run ended before the file was converted"). When `signal` fires
   * it returns at once, recording nothing.
   */
  drain(timeoutMs: number): Promise<void>;
  /** Stops the worker, ending a conversion in flight, and destroys the sandbox. */
  close(): Promise<void>;
}

export interface ReviewAssetsOptions {
  runId: string;
  recorder: Recorder;
  /** Creates the claim's convert sandbox (`convertSandboxSpec` with `convertMounts`). */
  createSandbox(signal: AbortSignal): Promise<Sandbox>;
  signal: AbortSignal;
  log(line: string): void;
}

export function reviewAssetsWorker(options: ReviewAssetsOptions): ReviewAssetsWorker {
  const { runId, recorder, log } = options;
  const root = supervisorThreadId(runId);
  const halt = new AbortController();
  const signal = AbortSignal.any([options.signal, halt.signal]);

  let scanned = 0;
  const finished = new Set<string>(); // has a stored assets.* event
  const known = new Map<string, Job>(); // queued once
  const queue: Job[] = [];
  let running: Job | undefined;
  let sandbox: Sandbox | undefined;

  /** Reads the events stored since the last scan. */
  function scan() {
    const events = recorder.events();
    for (; scanned < events.length; scanned++) {
      const event = events[scanned] as RunEvent;
      if (event.type === "assets.ready" || event.type === "assets.failed") {
        finished.add(event.payload.sourceSha256);
        continue;
      }
      const job = convertJob(event);
      if (job && !known.has(job.sha256)) {
        known.set(job.sha256, job);
        queue.push(job);
      }
    }
  }
  /** Every output seen so far without a stored `assets.*` event. */
  const pending = () => [...known.values()].filter((job) => !finished.has(job.sha256));

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done);
    });

  /**
   * Queues the job's `assets.*` event; `scan` marks it finished once it is stored. `emit`
   * retries, and its id is the job's, so a repeat is a no-op.
   */
  function record(job: Job, result: { manifest: ReviewAssetsManifest } | { error: string }) {
    const id = `${runId}:assets:${job.sha256}`;
    if ("manifest" in result)
      recorder.emit(root, "assets.ready", { ...result.manifest, sourceSha256: job.sha256 }, id);
    else {
      const error = result.error.slice(-ASSET_ERROR_MAX) || "conversion failed";
      recorder.emit(root, "assets.failed", { sourceSha256: job.sha256, error }, id);
    }
  }

  async function liveSandbox(): Promise<Sandbox> {
    // Idle timeouts end it between files; a command sent to an ended one fails.
    if (sandbox && (await sandbox.exitCode()) !== null) await dropSandbox();
    sandbox ??= await options.createSandbox(signal);
    return sandbox;
  }
  async function dropSandbox() {
    const old = sandbox;
    sandbox = undefined;
    await old?.destroy().catch((e) => log(`review assets: closing the sandbox failed: ${e}`));
  }

  /** One conversion's result, or a throw when the sandbox failed. */
  async function convert(
    job: Job,
  ): Promise<{ manifest: ReviewAssetsManifest } | { error: string }> {
    const box = await liveSandbox();
    const command =
      `python ${WORKFLOW}/workflows/core/convert/review_assets.py --source ${EVIDENCE}/${job.sha256} ` +
      `${job.flags} --out ${REVIEW}`;
    let stdout = "";
    let stderr = "";
    let code: number | undefined;
    for await (const chunk of box.exec(
      { command, timeoutSeconds: CONVERT_TIMEOUT_SECONDS },
      signal,
    )) {
      if (chunk.type === "exit") code = chunk.code;
      else if (chunk.type === "stdout") stdout += chunk.data;
      else stderr = (stderr + chunk.data).slice(-ASSET_ERROR_MAX * 2);
    }
    if (signal.aborted) throw signal.reason;
    if (code === undefined) throw new SandboxEndedError("the command stream ended without an exit");
    // A command whose sandbox died may report an exit code instead of throwing.
    if (code !== 0 && (await box.exitCode()) !== null)
      throw new SandboxEndedError(`the sandbox ended during the command (exit ${code})`);
    if (code === 124) return { error: `conversion timed out after ${CONVERT_TIMEOUT_SECONDS}s` };
    if (code !== 0) return { error: stderr.trim() || `the converter exited ${code}` };
    const last = stdout.trim().split("\n").at(-1) ?? "";
    let printed: unknown;
    try {
      printed = JSON.parse(last);
    } catch {
      return { error: `the converter printed no manifest: ${last.slice(0, 200)}` };
    }
    const sha = (printed as { sourceSha256?: unknown } | null)?.sourceSha256;
    if (sha !== job.sha256)
      return { error: `the converter reports ${String(sha)}, not ${job.sha256}` };
    const manifest = reviewAssetsManifestSchema.safeParse(printed);
    return manifest.success
      ? { manifest: manifest.data }
      : { error: `the converter's manifest is invalid: ${manifest.error.message}` };
  }

  async function work(job: Job) {
    log(`review assets: converting ${job.sha256.slice(0, 8)} (${job.flags})`);
    const started = Date.now();
    let failure = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await convert(job);
        record(job, result);
        const seconds = Math.round((Date.now() - started) / 1000);
        log(
          `review assets: ${job.sha256.slice(0, 8)} ${"manifest" in result ? "ready" : "failed"} in ${seconds}s`,
        );
        return;
      } catch (e) {
        if (signal.aborted) return; // stopped: the next claim finds the file again
        failure = e instanceof Error ? e.message : String(e);
        log(`review assets: ${job.sha256} attempt ${attempt} failed: ${failure}`);
        await dropSandbox();
      }
    }
    record(job, { error: `the convert sandbox failed twice: ${failure}` });
  }

  const nextJob = () => {
    for (let job = queue.shift(); job; job = queue.shift())
      if (!finished.has(job.sha256)) return job;
  };

  const loop = (async () => {
    while (!signal.aborted) {
      scan();
      const job = nextJob();
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }
      running = job;
      try {
        await work(job);
      } finally {
        running = undefined;
      }
    }
  })();
  loop.catch((e) => log(`review assets: worker stopped: ${e}`));

  return {
    async drain(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (!signal.aborted && Date.now() < deadline) {
        scan();
        if (!running && pending().length === 0) break;
        await sleep(250);
      }
      if (signal.aborted) return;
      const timedOut = Date.now() >= deadline;
      halt.abort();
      // A call that ignores the abort (creating a sandbox) must not hold the end of the run.
      await Promise.race([loop.catch(() => {}), new Promise((r) => setTimeout(r, HALT_GRACE_MS))]);
      // Everything queued so far is stored before the last scan, so what is still without an
      // event is final: an ended run is never claimed again.
      await recorder.flush();
      scan();
      if (options.signal.aborted) return; // a stop in the meantime: the run is resumed, not ended
      for (const job of pending())
        record(job, {
          error: timedOut ? "timed out" : "the run ended before the file was converted",
        });
      await recorder.flush();
    },
    async close() {
      halt.abort();
      await loop.catch(() => {});
      await dropSandbox();
    },
  };
}
