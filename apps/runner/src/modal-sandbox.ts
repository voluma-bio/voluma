/**
 * The Modal adapter for the Sandbox port, and the only file that imports `modal`.
 * Rules it follows (research/modal-poc.md in the docs repo):
 * - Sandboxes start from a published image; nothing is built at start.
 * - R2 prefixes are mounted with `cloudBucketMounts`. Each mount gets its own temporary
 *   R2 credential limited to its prefix and access and to the sandbox's lifetime, so there
 *   is nothing to refresh and no credential in the sandbox's env.
 * - Modal's exec timeout and the SDK offer no way to kill a command's children. Every
 *   command therefore runs as `setsid --wait timeout -k` and records its process group;
 *   an abort kills that group with a second exec, or terminates the sandbox if that fails.
 * - Read-only inputs flagged `stage` are copied to local disk at create, 32 files at a time.
 */

import { randomUUID } from "node:crypto";
import type {
  CreateSandbox,
  ExecChunk,
  ExecRequest,
  Sandbox,
  SandboxMount,
  SandboxSpec,
} from "@voluma/harness/ports/sandbox";
import { ModalClient, type Sandbox as ModalSandbox } from "modal";

export interface ModalSandboxConfig {
  /** The Modal app that owns the sandboxes; created if missing. */
  appName: string;
  r2: {
    accountId: string;
    bucket: string;
    /** The long-lived key that temporary credentials are minted from. */
    parentAccessKeyId: string;
    /** A Cloudflare API token that may mint R2 temporary credentials. */
    cloudflareApiToken: string;
  };
}

const STAGE_PARALLELISM = 32;
const STAGE_ROOT = "/staged";
const GROUP_DIR = "/tmp/voluma-exec";
const KILL_GRACE_SECONDS = 5;
// Credentials outlive the sandbox's lifetime by this much (Modal enforces lifetimes loosely).
const CREDENTIAL_MARGIN_SECONDS = 15 * 60;
// Modal's own exec deadline is a backstop behind `timeout -k`; it must not cut that short.
const EXEC_DEADLINE_MARGIN_SECONDS = 30;

export function createModalSandbox(config: ModalSandboxConfig): CreateSandbox {
  const client = new ModalClient();
  return async (spec) => {
    validate(spec);
    const [app, image] = await Promise.all([
      client.apps.fromName(config.appName, { createIfMissing: true }),
      client.images.fromName(spec.image),
    ]);
    const cloudBucketMounts: Record<
      string,
      ReturnType<typeof client.cloudBucketMounts.create>
    > = {};
    for (const mount of spec.mounts) {
      const secret = await client.secrets.fromObject(await mintCredentials(config, spec, mount));
      cloudBucketMounts[mount.path] = client.cloudBucketMounts.create(config.r2.bucket, {
        secret,
        readOnly: mount.access === "read-only",
        bucketEndpointUrl: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
        keyPrefix: mount.prefix,
      });
    }
    const modal = await client.sandboxes.create(app, image, {
      name: `${spec.runId}.${spec.name}`,
      tags: { run: spec.runId },
      cpu: spec.cpu,
      memoryMiB: spec.memoryMiB,
      gpu: spec.gpu,
      env: spec.env,
      cloudBucketMounts,
      timeoutMs: spec.lifetimeSeconds * 1000,
      idleTimeoutMs: spec.idleSeconds === undefined ? undefined : spec.idleSeconds * 1000,
      // Mounts are set up outside the sandbox; analysis code needs no network.
      blockNetwork: true,
    });
    const sandbox = new ModalSandboxAdapter(modal, spec);
    try {
      await sandbox.stage();
    } catch (error) {
      await sandbox.destroy();
      throw error;
    }
    return sandbox;
  };
}

class ModalSandboxAdapter implements Sandbox {
  readonly paths: Record<string, string>;
  readonly #modal: ModalSandbox;
  readonly #mounts: SandboxMount[];

  constructor(modal: ModalSandbox, spec: SandboxSpec) {
    this.#modal = modal;
    this.#mounts = spec.mounts;
    this.paths = Object.fromEntries(
      spec.mounts.map((m) => [m.path, m.stage ? `${STAGE_ROOT}${m.path}` : m.path]),
    );
  }

  async stage(): Promise<void> {
    for (const mount of this.#mounts.filter((m) => m.stage)) {
      // Paths are positional arguments, never spliced into the script.
      const script =
        'set -e; mkdir -p "$2"; cd "$1"; find . -type f -print0 | ' +
        `xargs -0 -r -P ${STAGE_PARALLELISM} -n 16 cp --parents -t "$2"`;
      let code = -1;
      for await (const chunk of this.#run(
        ["bash", "-c", script, "_", mount.path, this.paths[mount.path] as string],
        3600,
      )) {
        if (chunk.type === "exit") code = chunk.code;
      }
      if (code !== 0) throw new Error(`staging ${mount.path} failed with exit code ${code}`);
    }
  }

  async *exec(request: ExecRequest, signal?: AbortSignal): AsyncGenerator<ExecChunk> {
    if (signal?.aborted) {
      yield { type: "exit", code: 143 };
      return;
    }
    const id = randomUUID();
    // The inner shell records its process group, then becomes the command.
    const script = `mkdir -p ${GROUP_DIR}; awk '{print $5}' /proc/$$/stat > ${GROUP_DIR}/${id}; exec bash -c "$0"`;
    const argv = [
      "setsid",
      "--wait",
      "timeout",
      "-k",
      String(KILL_GRACE_SECONDS),
      String(request.timeoutSeconds),
      "bash",
      "-c",
      script,
      request.command,
    ];
    let killing: Promise<void> | undefined;
    const kill = () => {
      killing ??= this.#killGroup(id);
    };
    signal?.addEventListener("abort", kill);
    let finished = false;
    try {
      for await (const chunk of this.#run(
        argv,
        request.timeoutSeconds + KILL_GRACE_SECONDS,
        request.env,
      )) {
        finished = chunk.type === "exit";
        // `setsid --wait` reports a child killed by a signal as the bare signal number;
        // the caller knows it aborted, so say so.
        yield finished && signal?.aborted ? { type: "exit", code: 143 } : chunk;
      }
    } catch (error) {
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

  async destroy(): Promise<void> {
    await this.#modal.terminate({ wait: true });
  }

  async *#run(
    argv: string[],
    deadlineSeconds: number,
    env?: Record<string, string>,
  ): AsyncGenerator<ExecChunk> {
    const process = await this.#modal.exec(argv, {
      env,
      timeoutMs: (deadlineSeconds + EXEC_DEADLINE_MARGIN_SECONDS) * 1000,
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
    while (live.size > 0) {
      const { type, result } = await Promise.race(live.values());
      if (result.done) live.delete(type);
      else {
        live.set(type, next(type));
        yield { type, data: result.value };
      }
    }
    yield { type: "exit", code: await process.wait() };
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

// Empty prefixes would mount the bucket root, and overlapping ones would let a read-only
// path see a read-write one.
function validate(spec: SandboxSpec): void {
  for (const { path, prefix, access, stage } of spec.mounts) {
    if (prefix === "" || prefix.startsWith("/") || !prefix.endsWith("/")) {
      throw new Error(`invalid mount prefix "${prefix}": needs a trailing slash, no leading one`);
    }
    if (!path.startsWith("/") || path === "/") throw new Error(`invalid mount path "${path}"`);
    if (stage && access !== "read-only") throw new Error(`only read-only mounts stage: ${path}`);
  }
  for (const a of spec.mounts) {
    for (const b of spec.mounts) {
      if (a !== b && (b.prefix.startsWith(a.prefix) || b.path.startsWith(`${a.path}/`))) {
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
