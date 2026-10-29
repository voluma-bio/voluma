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
 * - Read-only inputs flagged `stage` are copied to local disk at their path at create, 32
 *   files at a time (the copy is writable: commands run as root, and a sandbox cannot
 *   remount or `chattr` a path or run as another user and still write the mounts); the bucket is mounted at a private path under /staged for the copy.
 * - Network follows the spec: none (`blockNetwork`), or HTTPS to the listed hosts only
 *   (`outboundDomainAllowlist`; probed on 0.11.1: plain HTTP, other hosts and IPs are refused,
 *   but DNS lookups of any name still resolve).
 * - Each sandbox gets a fresh name and the tags `{run, name, claim, startedAt}` (`startedAt` is epoch
 *   ms; the SDK exposes no creation time, and `sandboxes:clean` reports age from it). Modal limits
 *   a name to 64 characters, so the Modal name is `<spec.name>.<8 hex>` without the run id (the
 *   `run` tag carries it) and `validate` rejects a longer one. Sandboxes a dead process left behind
 *   are ended by the next claim (`terminateOtherClaims`), and one's own after a slow close by
 *   claim (`terminateClaim`), never by run. Creation is aborted once the run's lease is
 *   released or lost (a process frozen past its lease can still act late).
 */

import { randomUUID } from "node:crypto";
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
const STAGE_PARALLELISM = 32;
// Extra passes over the files whose copy failed (a bucket mount fails reads now and then).
const STAGE_RETRIES = 3;
// Tail of the stage command's stderr kept in the error.
const STAGE_STDERR_CHARS = 4000;
// Copies the files under "$1" to "$2" in parallel. A pass records each file whose `cp` fails
// in a NUL list; the next pass copies only those, so a copied file is never copied again.
// Paths are positional arguments, never spliced into the script.
const STAGE_SCRIPT = `set -eo pipefail; mkdir -p "$2"; cd "$1"; todo=$(mktemp); failed=$(mktemp); trap 'rm -f "$todo" "$failed"' EXIT
find . -type f -print0 > "$todo"
for pass in $(seq 0 ${STAGE_RETRIES}); do
  : > "$failed"
  xargs -0 -r -P ${STAGE_PARALLELISM} -n 16 bash -c 'out=$0; list=$1; shift; for f; do cp --parents -t "$out" "$f" || printf "%s\\0" "$f" >> "$list"; done' "$2" "$failed" < "$todo"
  [ -s "$failed" ] || break
  cp "$failed" "$todo"
done
if [ -s "$failed" ]; then echo "could not copy: $(tr '\\0' ' ' < "$failed" | head -c 1000)" >&2; exit 1; fi
test "$(find . -type f | wc -l)" = "$(cd "$2" && find . -type f | wc -l)"`;
const STAGE_ROOT = "/staged";
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

/**
 * Asks Modal to terminate every live sandbox of the run that another claim started, without
 * waiting for it to stop; returns how many. Called right after a claim succeeds: the claim holds
 * the lease, so what an earlier claim left running (a crashed or lost runner) must not keep
 * writing the run's mounts or spending. The app is created by the first sandbox, so none yet
 * means nothing to end.
 */
export async function terminateOtherClaims(
  modal: ModalSandboxConfig["modal"],
  runId: string,
  claim: string,
  signal?: AbortSignal,
): Promise<number> {
  const client = new ModalClient(modal);
  const app = await client.apps.fromName(RUNS_APP).catch((error) => {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  });
  if (!app) return 0;
  let ended = 0;
  for await (const sandbox of client.sandboxes.list({ appId: app.appId, tags: { run: runId } })) {
    signal?.throwIfAborted();
    if ((await sandbox.getTags()).claim === claim) continue;
    await sandbox.terminate();
    ended++;
  }
  return ended;
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
      const secret = await client.secrets.fromObject(await mintCredentials(config, spec, mount));
      cloudBucketMounts[mountedAt(mount)] = client.cloudBucketMounts.create(config.r2.bucket, {
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
      // Mounts are set up outside the sandbox, so they work with either policy (probed:
      // writes too). Modal then refuses everything but HTTPS to the listed hosts.
      ...(spec.network.kind === "none"
        ? { blockNetwork: true }
        : { outboundDomainAllowlist: spec.network.hosts }),
    });
    const sandbox = new ModalSandboxAdapter(modal, spec);
    try {
      signal?.throwIfAborted();
      await sandbox.stage();
    } catch (error) {
      await sandbox.destroy();
      throw error;
    }
    return sandbox;
  };
}

class ModalSandboxAdapter implements Sandbox {
  readonly #modal: ModalSandbox;
  readonly #mounts: SandboxMount[];
  readonly #lifetimeSeconds: number;
  readonly #workdir: string | undefined;

  constructor(modal: ModalSandbox, spec: SandboxSpec) {
    this.#modal = modal;
    this.#workdir = spec.workdir;
    this.#lifetimeSeconds = spec.lifetimeSeconds;
    this.#mounts = spec.mounts;
  }

  async stage(): Promise<void> {
    for (const mount of this.#mounts.filter((m) => m.stage)) {
      let code = -1;
      let stderr = "";
      for await (const chunk of this.#run(
        ["bash", "-c", STAGE_SCRIPT, "_", mountedAt(mount), mount.path],
        3600,
      )) {
        if (chunk.type === "exit") code = chunk.code;
        else if (chunk.type === "stderr") stderr = (stderr + chunk.data).slice(-STAGE_STDERR_CHARS);
      }
      if (code !== 0) {
        throw new Error(`staging ${mount.path} failed (exit ${code}): ${stderr.trim()}`);
      }
    }
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
  ): AsyncGenerator<ExecChunk> {
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
    try {
      while (live.size > 0) {
        const { type, result } = await Promise.race(live.values());
        if (result.done) live.delete(type);
        else {
          live.set(type, next(type));
          yield { type, data: result.value };
        }
      }
      yield { type: "exit", code: await process.wait() };
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

// Where the bucket prefix is mounted: a staged mount is mounted privately and copied to its path.
const mountedAt = (mount: SandboxMount) =>
  mount.stage ? `${STAGE_ROOT}${mount.path}` : mount.path;

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
  // The role fixes the network: only a worker may reach out, and only to hosts.
  if (spec.network.kind === "hosts") {
    if (spec.role !== "worker")
      throw new Error(`a ${spec.role} sandbox cannot have network access`);
    if (spec.network.hosts.length === 0) {
      throw new Error("a sandbox with a host allowlist needs at least one host");
    }
  }
  // The Modal name is `<name>.<8 hex>`, and Modal refuses one over 64 characters.
  if (spec.name.length + 9 > MAX_MODAL_NAME) {
    throw new Error(
      `sandbox name "${spec.name}" is ${spec.name.length} characters; the most is ${MAX_MODAL_NAME - 9}`,
    );
  }
  for (const { path, prefix, access, stage } of spec.mounts) {
    if (prefix === "" || prefix.startsWith("/") || !prefix.endsWith("/")) {
      throw new Error(`invalid mount prefix "${prefix}": needs a trailing slash, no leading one`);
    }
    if (!/^(\/[\w.-]+)+$/.test(path) || path.split("/").some((part) => part === "..")) {
      throw new Error(`invalid mount path "${path}"`);
    }
    // The adapter's own files live here.
    if ([STAGE_ROOT, "/tmp"].some((p) => path === p || path.startsWith(`${p}/`))) {
      throw new Error(`reserved mount path "${path}"`);
    }
    if (stage && access !== "read-only") throw new Error(`only read-only mounts stage: ${path}`);
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

/** Mints a temporary R2 credential for one prefix, as the S3 variables Modal's mount expects. */
async function mintCredentials(
  { r2 }: ModalSandboxConfig,
  spec: SandboxSpec,
  mount: SandboxMount,
): Promise<Record<string, string>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${r2.accountId}/r2/temp-access-credentials`,
    {
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
    },
  );
  if (!response.ok) {
    throw new Error(`minting R2 credentials failed: ${response.status} ${await response.text()}`);
  }
  const { result } = (await response.json()) as {
    result: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  };
  return {
    AWS_ACCESS_KEY_ID: result.accessKeyId,
    AWS_SECRET_ACCESS_KEY: result.secretAccessKey,
    AWS_SESSION_TOKEN: result.sessionToken,
  };
}
