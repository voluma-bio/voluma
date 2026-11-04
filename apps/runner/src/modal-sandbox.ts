/**
 * The Modal adapter for the Sandbox port, and the only file that imports `modal`.
 * Rules it follows (research/modal-poc.md in the docs repo):
 * - Sandboxes start from a public registry image pinned by digest, which Modal pulls and
 *   caches per workspace; the runner builds nothing.
 * - R2 prefixes are mounted with `cloudBucketMounts`. Each mount gets its own temporary
 *   R2 credential limited to its prefix and access and to the sandbox's lifetime, so there
 *   is nothing to refresh and no credential in the sandbox's env.
 * - Modal's exec timeout and the SDK offer no way to kill a command's children. Every
 *   command therefore runs under `timeout -k` (which leads its own process group and
 *   signals all of it) and records that group;
 *   an abort kills that group with a second exec, or terminates the sandbox if that fails.
 * - Network follows the spec: none (`blockNetwork`), TLS SNI allowlist
 *   (`outboundDomainAllowlist`, vulnerable to shared-edge Host routing), or one dedicated
 *   IPv4 (`outboundCidrAllowlist`, /32, any protocol). Allowlists still permit DNS (#236).
 * - Each sandbox gets a fresh name and the tags `{run, name, claim, startedAt}` (`startedAt` is epoch
 *   ms; the SDK exposes no creation time, and `sandboxes:clean` reports age from it). Modal limits
 *   a name to 64 characters, so the Modal name is `<spec.name>.<8 hex>` without the run id (the
 *   `run` tag carries it) and `validate` rejects a longer one. Sandboxes a dead process left behind
 *   are ended by the next claim (`endOtherClaims`), and one's own after a slow close by
 *   claim (`terminateClaim`), never by run. Creation is aborted once the run's lease is
 *   released or lost (a process frozen past its lease can still act late).
 */

import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import { setTimeout } from "node:timers/promises";
import {
  type CreateSandbox,
  type ExecChunk,
  type ExecRequest,
  type Sandbox,
  SandboxEndedError,
  type SandboxMount,
  type SandboxSpec,
} from "@voluma/harness/ports/sandbox";
import { ModalClient, type Sandbox as ModalSandbox, NotFoundError } from "modal";
import type { Config } from "./config.ts";
import { withTransientRetry } from "./transient.ts";

export interface ModalSandboxConfig {
  /** Modal API credentials; absent: the SDK uses ~/.modal.toml. */
  modal?: { tokenId: string; tokenSecret: string };
  /** The Modal app that owns the sandboxes; created if missing. */
  appName: string;
  /**
   * Names this claim of the run, tagged on every sandbox it creates, so `terminateClaim` ends
   * only these: a run released and reclaimed has the next claimer's sandboxes under the same
   * run tag while this claim is still cleaning up.
   */
  claim: string;
  r2: {
    accountId: string;
    bucket: string;
    /** The long-lived key that temporary credentials are minted from. */
    parentAccessKeyId: string;
    /** A Cloudflare API token that may mint R2 temporary credentials. */
    cloudflareApiToken: string;
  };
}

const MAX_MODAL_NAME = 64;
const GROUP_DIR = "/tmp/voluma-exec";
const KILL_GRACE_SECONDS = 5;
// Credentials outlive the sandbox's lifetime by this much (Modal enforces lifetimes loosely).
const CREDENTIAL_MARGIN_SECONDS = 15 * 60;
// Modal's own exec deadline is a backstop behind `timeout -k`; it must not cut that short.
const EXEC_DEADLINE_MARGIN_SECONDS = 30;

/** The Modal app that owns every sandbox the runner creates; `sandboxes:clean` sweeps it. */
export const RUNS_APP = "voluma-runs";

/** Asks Modal to terminate every live sandbox of one claim of a run, without waiting for it to stop. */
export async function terminateClaim(
  modal: ModalSandboxConfig["modal"],
  runId: string,
  claim: string,
) {
  const client = new ModalClient(modal);
  const app = await client.apps.fromName(RUNS_APP);
  const live = client.sandboxes.list({ appId: app.appId, tags: { run: runId, claim } });
  for await (const sandbox of live) await sandbox.terminate();
}

/** The live sandboxes of the run that another claim started. The app is created by the first sandbox, so none yet means none. */
async function* otherClaims(
  modal: ModalSandboxConfig["modal"],
  runId: string,
  claim: string,
  signal?: AbortSignal,
) {
  const client = new ModalClient(modal);
  const app = await client.apps.fromName(RUNS_APP).catch((error) => {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  });
  if (!app) return;
  for await (const sandbox of client.sandboxes.list({ appId: app.appId, tags: { run: runId } })) {
    signal?.throwIfAborted();
    if ((await sandbox.getTags()).claim !== claim) yield sandbox;
  }
}

const GRPC_NOT_FOUND = 5;

function isGone(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === GRPC_NOT_FOUND;
}

/** Modal's exit code for a sandbox, or a non-null stand-in when Modal no longer knows it. */
async function pollOrGone(sandbox: ModalSandbox): Promise<number | null> {
  try {
    return await sandbox.poll();
  } catch (e) {
    if (isGone(e)) return 0;
    throw e;
  }
}

const POLL_MS = 1000;
const PROGRESS_LOG_MS = 30_000;

/**
 * Ends every live sandbox of the run that another claim started, and returns only once Modal has
 * reported each one terminated (`poll` returns an exit code) and a fresh listing shows none left.
 * Called right after a claim succeeds and before it starts any sandbox: the claim holds the lease,
 * and an earlier claim's sandbox (a crashed or lost runner's) that is still alive could write over
 * this claim's `/outputs` or scratch on the shared mounts.
 *
 * There is no deadline: a guess shorter than Modal's own would start a writer beside a live one.
 * Transient Modal errors are retried with backoff and logged; a permanent one (a revoked token)
 * throws, so the claim fails with its message. The wait ends when termination is confirmed or
 * `signal` aborts (a stop, shutdown or lost lease), and a sandbox Modal never reports still ends
 * at its lifetime limit. While waiting the claim heartbeats and starts nothing.
 */
export async function endOtherClaims(
  modal: ModalSandboxConfig["modal"],
  runId: string,
  claim: string,
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<number> {
  const started = Date.now();
  const ended = new Set<string>();
  let nextLog = started;
  return withTransientRetry(
    "ending an earlier claim's sandboxes",
    signal,
    log,
    async () => {
      for (;;) {
        const live: ModalSandbox[] = [];
        for await (const sandbox of otherClaims(modal, runId, claim, signal)) live.push(sandbox);
        if (live.length === 0) return ended.size;
        for (const sandbox of live) {
          if (ended.has(sandbox.sandboxId)) continue;
          await sandbox.terminate().catch((e) => {
            if (!isGone(e)) throw e;
          });
          ended.add(sandbox.sandboxId);
        }
        // Our own loop, not `terminate({wait: true})`: the SDK's wait cannot be stopped by a signal.
        for (let pending = live; pending.length > 0; ) {
          if (Date.now() >= nextLog) {
            log(
              `waiting for ${pending.length} sandbox${pending.length === 1 ? "" : "es"} of an earlier claim to terminate (${Math.round((Date.now() - started) / 1000)} s)`,
            );
            nextLog = Date.now() + PROGRESS_LOG_MS;
          }
          await setTimeout(POLL_MS, undefined, { signal });
          const codes = await Promise.all(pending.map(pollOrGone));
          pending = pending.filter((_, i) => codes[i] === null);
        }
      }
    },
    Infinity,
  );
}

/** The sandbox factory of one claim of a run: `run.ts` and `dev-sandbox.ts` build theirs here. */
export function claimSandboxes(
  config: Config,
  modal: ModalSandboxConfig["modal"],
  claim: string,
): CreateSandbox {
  return createModalSandbox({
    appName: RUNS_APP,
    claim,
    modal,
    r2: {
      accountId: config.r2.accountId,
      bucket: config.r2.bucket,
      parentAccessKeyId: config.r2.accessKeyId,
      cloudflareApiToken: config.r2.cloudflareApiToken,
    },
  });
}

export function createModalSandbox(config: ModalSandboxConfig): CreateSandbox {
  const client = new ModalClient(config.modal);
  return async (spec, signal) => {
    validate(spec);
    signal?.throwIfAborted();
    const [app, image] = await Promise.all([
      client.apps.fromName(config.appName, { createIfMissing: true }),
      client.images.fromRegistry(spec.image),
    ]);
    const cloudBucketMounts: Record<
      string,
      ReturnType<typeof client.cloudBucketMounts.create>
    > = {};
    for (const mount of spec.mounts) {
      const secret = await client.secrets.fromObject(
        await mintCredentials(config, spec, mount, signal),
      );
      cloudBucketMounts[mount.path] = client.cloudBucketMounts.create(config.r2.bucket, {
        secret,
        readOnly: mount.access === "read-only",
        bucketEndpointUrl: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
        keyPrefix: mount.prefix,
      });
    }
    signal?.throwIfAborted();
    const modal = await client.sandboxes.create(app, image, {
      name: `${spec.name}.${randomUUID().slice(0, 8)}`,
      tags: {
        run: spec.runId,
        name: spec.name,
        claim: config.claim,
        startedAt: String(Date.now()),
      },
      cpu: spec.cpu,
      memoryMiB: spec.memoryMiB,
      gpu: spec.gpu,
      env: spec.env,
      cloudBucketMounts,
      timeoutMs: spec.lifetimeSeconds * 1000,
      idleTimeoutMs: spec.idleSeconds === undefined ? undefined : spec.idleSeconds * 1000,
      // Do not combine allowlists: Modal treats them as a union, reopening domain fronting.
      ...(spec.network.kind === "none"
        ? { blockNetwork: true }
        : spec.network.kind === "ipv4"
          ? { outboundCidrAllowlist: [`${spec.network.address}/32`] }
          : { outboundDomainAllowlist: spec.network.hosts }),
    });
    const sandbox = new ModalSandboxAdapter(modal, spec);
    try {
      signal?.throwIfAborted();
    } catch (error) {
      await sandbox.destroy();
      throw error;
    }
    return sandbox;
  };
}

class ModalSandboxAdapter implements Sandbox {
  readonly #modal: ModalSandbox;
  readonly #lifetimeSeconds: number;
  readonly #workdir: string | undefined;

  constructor(modal: ModalSandbox, spec: SandboxSpec) {
    this.#modal = modal;
    this.#workdir = spec.workdir;
    this.#lifetimeSeconds = spec.lifetimeSeconds;
  }

  async *exec(request: ExecRequest, signal?: AbortSignal): AsyncGenerator<ExecChunk> {
    // `timeout 0` would mean no timeout, and Modal's deadline needs whole seconds.
    if (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds <= 0) {
      throw new Error(`invalid timeoutSeconds: ${request.timeoutSeconds}`);
    }
    if (signal?.aborted) {
      yield { type: "exit", code: 143 };
      return;
    }
    // A command must not outlive the sandbox that Modal ends at its lifetime.
    const timeoutSeconds = Math.min(request.timeoutSeconds, this.#lifetimeSeconds);
    const id = randomUUID();
    // The inner shell records its process group, enters the working folder (made first: on a
    // bucket mount an empty prefix is no directory), then becomes the command.
    const script = `mkdir -p ${GROUP_DIR}; awk '{print $5}' /proc/$$/stat > ${GROUP_DIR}/${id}; mkdir -p -- "$1" && cd -- "$1" || exit 1; exec bash -c "$0"`;
    const argv = [
      "timeout",
      "-k",
      String(KILL_GRACE_SECONDS),
      String(timeoutSeconds),
      "bash",
      "-c",
      script,
      request.command,
      this.#workdir ?? ".",
    ];
    let killing: Promise<void> | undefined;
    const kill = () => {
      killing ??= this.#killGroup(id);
    };
    signal?.addEventListener("abort", kill);
    let finished = false;
    try {
      for await (const chunk of this.#run(argv, timeoutSeconds + KILL_GRACE_SECONDS, request.env)) {
        finished = chunk.type === "exit";
        // The caller knows it aborted, so say so whatever the signal made the exit code.
        yield finished && signal?.aborted ? { type: "exit", code: 143 } : chunk;
      }
    } catch (error) {
      // Nothing started, so there is no group to kill.
      if (error instanceof SandboxEndedError) finished = true;
      // Killing the sandbox as a fallback ends the streams with an error.
      if (!signal?.aborted) throw error;
      finished = true;
      yield { type: "exit", code: 143 };
    } finally {
      signal?.removeEventListener("abort", kill);
      // A reader that stops early must not leave the command running.
      if (!finished) kill();
      await killing;
    }
  }

  async writeFile(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    // A cloud-bucket mount cannot append or be written piecemeal (reopening a file there
    // fails with ENOENT), so the file is written locally first and copied in one go.
    const tmp = `/tmp/voluma-write-${randomUUID()}`;
    signal?.throwIfAborted();
    await this.#modal.filesystem.writeBytes(bytes, tmp);
    signal?.throwIfAborted();
    let code = -1;
    let stderr = "";
    // Paths are positional arguments, never spliced into the script.
    const script = 'mkdir -p "$(dirname "$2")" && cp "$1" "$2"; rc=$?; rm -f "$1"; exit $rc';
    for await (const chunk of this.#run(["bash", "-c", script, "_", tmp, path], 60)) {
      if (chunk.type === "exit") code = chunk.code;
      else if (chunk.type === "stderr") stderr += chunk.data;
    }
    if (code !== 0) throw new Error(`writing ${path} failed (exit ${code}): ${stderr.trim()}`);
  }

  exitCode(): Promise<number | null> {
    return this.#modal.poll(); // null while the sandbox runs
  }

  async destroy(): Promise<void> {
    await this.#modal.terminate({ wait: true });
  }

  async *#run(
    argv: string[],
    deadlineSeconds: number,
    env?: Record<string, string>,
    signal?: AbortSignal,
  ): AsyncGenerator<ExecChunk> {
    signal?.throwIfAborted();
    const process = await this.#modal
      .exec(argv, {
        env,
        timeoutMs: (deadlineSeconds + EXEC_DEADLINE_MARGIN_SECONDS) * 1000,
      })
      .catch((error: unknown) => {
        throw isShuttingDown(error) ? new SandboxEndedError(error) : error;
      });
    const readers = {
      stdout: process.stdout.getReader(),
      stderr: process.stderr.getReader(),
    };
    const next = (type: "stdout" | "stderr") =>
      readers[type].read().then((result) => ({ type, result }));
    const live = new Map([
      ["stdout", next("stdout")],
      ["stderr", next("stderr")],
    ]);
    // An abort rejects every wait below, so a reader parked on a silent stream stops at once.
    const aborted = new Promise<never>((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
    aborted.catch(() => {});
    try {
      while (live.size > 0) {
        const { type, result } = await Promise.race([...live.values(), aborted]);
        if (result.done) live.delete(type);
        else {
          live.set(type, next(type));
          yield { type, data: result.value };
        }
      }
      yield { type: "exit", code: await Promise.race([process.wait(), aborted]) };
    } finally {
      // A reader that stops early, or a stream that errors later, must not leave
      // an unhandled rejection that ends the runner.
      for (const pending of live.values()) pending.catch(() => {});
      for (const reader of Object.values(readers)) reader.cancel().catch(() => {});
    }
  }

  /** Kills the command's whole process group; if that fails, ends the sandbox. */
  async #killGroup(id: string): Promise<void> {
    const script =
      // The abort may land before the command has recorded its group; give it a moment.
      `for i in $(seq 50); do [ -s ${GROUP_DIR}/${id} ] && break; sleep 0.1; done; ` +
      `g=$(cat ${GROUP_DIR}/${id}) || exit 3; kill -TERM -- -$g; ` +
      `for i in $(seq ${KILL_GRACE_SECONDS * 10}); do kill -0 -- -$g 2>/dev/null || exit 0; sleep 0.1; done; ` +
      "kill -KILL -- -$g 2>/dev/null; exit 0";
    try {
      let code = -1;
      for await (const chunk of this.#run(["bash", "-c", script], 30)) {
        if (chunk.type === "exit") code = chunk.code;
      }
      if (code === 0) return;
    } catch {
      // Fall through: the sandbox is the unit we can still kill.
    }
    await this.destroy();
  }
}

// Modal refuses to start a command in a sandbox it is ending, while `poll()` still says the
// sandbox runs (seen for at least 15 s after the idle timeout). nice-grpc's ClientError,
// matched by shape so this file needs no nice-grpc import; 9 is FAILED_PRECONDITION. The
// SDK does not retry that status, and the failure is the start itself, so nothing ran.
function isShuttingDown(error: unknown): boolean {
  const { code, details } = error as { code?: unknown; details?: unknown };
  return code === 9 && typeof details === "string" && details.includes("shutting down");
}

// Empty prefixes would mount the bucket root, and overlapping ones would let a read-only
// path see a read-write one.
function validate(spec: SandboxSpec): void {
  for (const [name, seconds] of [
    ["lifetimeSeconds", spec.lifetimeSeconds],
    ["idleSeconds", spec.idleSeconds],
  ] as const) {
    if (seconds !== undefined && !(Number.isInteger(seconds) && seconds > 0)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (spec.network.kind !== "none") {
    if (spec.network.kind === "hosts" && spec.network.hosts.length === 0) {
      throw new Error("a sandbox with a host allowlist needs at least one host");
    }
    if (spec.network.kind === "ipv4" && !isIPv4(spec.network.address)) {
      throw new Error("a sandbox IPv4 allowlist needs one IPv4 address (no CIDR)");
    }
  }
  // The Modal name is `<name>.<8 hex>`, and Modal refuses one over 64 characters.
  if (spec.name.length + 9 > MAX_MODAL_NAME) {
    throw new Error(
      `sandbox name "${spec.name}" is ${spec.name.length} characters; the most is ${MAX_MODAL_NAME - 9}`,
    );
  }
  for (const { path, prefix } of spec.mounts) {
    if (prefix === "" || prefix.startsWith("/") || !prefix.endsWith("/")) {
      throw new Error(`invalid mount prefix "${prefix}": needs a trailing slash, no leading one`);
    }
    if (!/^(\/[\w.-]+)+$/.test(path) || path.split("/").some((part) => part === "..")) {
      throw new Error(`invalid mount path "${path}"`);
    }
    // The adapter's own files live here.
    if (path === "/tmp" || path.startsWith("/tmp/")) {
      throw new Error(`reserved mount path "${path}"`);
    }
  }
  for (const a of spec.mounts) {
    for (const b of spec.mounts) {
      if (
        a !== b &&
        (b.prefix.startsWith(a.prefix) || b.path === a.path || b.path.startsWith(`${a.path}/`))
      ) {
        throw new Error(`overlapping mounts: ${a.path} (${a.prefix}), ${b.path} (${b.prefix})`);
      }
    }
  }
}

// Cloudflare's mint endpoint sometimes answers 403 code 10042 ("Please enable R2") for an account
// that has R2: seen once, gone 41 s later. A bad token is a different 403 and must not be retried.
// 5 attempts with 1, 2, 4 and 8 s between them: at most ~15 s of waiting per mount.
const MINT_ATTEMPTS = 5;
const MINT_BACKOFF_MS = 1000;

/** Whether a failed mint is worth another try: a server or rate-limit error, or the spurious 10042. */
export function isTransientMintFailure(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  return status === 403 && /"code"\s*:\s*10042\b/.test(body);
}

/** Mints a temporary R2 credential for one prefix, as the S3 variables Modal's mount expects. */
async function mintCredentials(
  { r2 }: ModalSandboxConfig,
  spec: SandboxSpec,
  mount: SandboxMount,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const request = {
    method: "POST",
    headers: {
      authorization: `Bearer ${r2.cloudflareApiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      bucket: r2.bucket,
      parentAccessKeyId: r2.parentAccessKeyId,
      permission: mount.access === "read-only" ? "object-read-only" : "object-read-write",
      ttlSeconds: spec.lifetimeSeconds + CREDENTIAL_MARGIN_SECONDS,
      prefixes: [mount.prefix],
    }),
    signal,
  };
  const url = `https://api.cloudflare.com/client/v4/accounts/${r2.accountId}/r2/temp-access-credentials`;
  for (let attempt = 1; ; attempt++) {
    let failure: string;
    let transient: boolean;
    try {
      const response = await fetch(url, request);
      if (response.ok) {
        const { result } = (await response.json()) as {
          result: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
        };
        return {
          AWS_ACCESS_KEY_ID: result.accessKeyId,
          AWS_SECRET_ACCESS_KEY: result.secretAccessKey,
          AWS_SESSION_TOKEN: result.sessionToken,
        };
      }
      const body = await response.text();
      failure = `${response.status} ${body}`;
      transient = isTransientMintFailure(response.status, body);
    } catch (error) {
      // A network error; an abort must end the creation, not be retried.
      signal?.throwIfAborted();
      failure = String(error);
      transient = true;
    }
    if (!transient || attempt === MINT_ATTEMPTS) {
      throw new Error(`minting R2 credentials failed: ${failure}`);
    }
    await setTimeout(MINT_BACKOFF_MS * 2 ** (attempt - 1), undefined, { signal });
  }
}
