/**
 * The Cloudflare adapter for the Sandbox port: a `RunSandbox` Durable Object per
 * sandbox (named `<runId>/<name>`) that owns a container, and `durableObjectSandbox`,
 * the port implementation that talks to it. The Worker holds the R2 credentials;
 * the container only sees the mounts, through S3Gateway, and has no internet.
 *
 * Wire format of `POST /exec`: a JSON ExecRequest in, NDJSON ExecChunks out.
 */

import { DurableObject } from "cloudflare:workers";
import { type S3GatewayBinding, S3Mount, type S3MountRequest } from "@cloudflare/sandbox";
import type { ExecChunk, ExecRequest, Sandbox, SandboxMounts } from "../ports";

export interface RunSandboxEnv {
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
}

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
// The image's Python lives in /opt/venv; commands inherit nothing but what we set here.
const BASE_ENV = { PATH: "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" };

// A mount's path is its trust boundary, so the table is the only place they are named.
const MOUNT_TABLE = [
  { path: "/workflow", key: "workflow", access: "read-only" },
  { path: "/inputs", key: "inputs", access: "read-only" },
  { path: "/scratch", key: "scratch", access: "read-write" },
  { path: "/outputs", key: "outputs", access: "read-write" },
] as const satisfies readonly { path: string; key: keyof SandboxMounts; access: string }[];

interface RunSandboxState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & { readonly S3Gateway: S3GatewayBinding };
}

export class RunSandbox extends DurableObject<RunSandboxEnv> {
  readonly #container: Container;
  readonly #mounts: S3Mount;

  constructor(ctx: RunSandboxState, env: RunSandboxEnv) {
    super(ctx, env);
    if (ctx.container === undefined) throw new Error("RunSandbox needs a container binding");
    this.#container = ctx.container;
    this.#mounts = new S3Mount(ctx.container, ctx.exports.S3Gateway);
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/exec") {
      return this.#exec((await request.json()) as ExecRequest, request.signal);
    }
    if (request.method === "DELETE" && pathname === "/") {
      if (this.#container.running) await this.#container.destroy();
      return new Response(null, { status: 204 });
    }
    return new Response("Not found", { status: 404 });
  }

  async #exec(request: ExecRequest, signal: AbortSignal): Promise<Response> {
    validate(request);
    // Event-log seam: once the EventLog adapter lands, record `sandbox` events under
    // request.threadId here (container started, mounted, exec started, exec exited), each
    // with an id from crypto.randomUUID().
    await this.#ensureRunning(request.mounts);
    // `timeout` puts the command in its own process group, so SIGTERM to it (below) reaches
    // the command's children; -k follows with SIGKILL.
    const process = await this.#container.exec(
      ["timeout", "-k", "5", String(request.timeoutSeconds), "bash", "-c", request.command],
      { cwd: "/outputs", env: { ...request.env, ...BASE_ENV }, stdout: "pipe", stderr: "pipe" },
    );
    if (!process.stdout || !process.stderr) throw new Error("exec returned no output streams");
    const { stdout, stderr } = process;
    // The process may already have exited when the abort lands.
    const kill = () => {
      try {
        process.kill(15);
      } catch {}
    };
    // The signal fires when the client disconnects (compatibility flag enable_request_signal).
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill);

    const { readable, writable } = new TransformStream<ExecChunk, ExecChunk>();
    const writer = writable.getWriter();
    const pump = async (type: "stdout" | "stderr", stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const bytes of stream) {
        await writer.write({ type, data: decoder.decode(bytes, { stream: true }) });
      }
      const rest = decoder.decode();
      if (rest) await writer.write({ type, data: rest });
    };
    void Promise.all([pump("stdout", stdout), pump("stderr", stderr)])
      .then(async () => writer.write({ type: "exit", code: await process.exitCode }))
      .then(() => writer.close())
      .catch((error) => {
        // A failed pump or a consumer that stopped reading must not leave the command running.
        kill();
        return writer.abort(error);
      })
      .finally(() => signal.removeEventListener("abort", kill));

    return new Response(readable.pipeThrough(ndjson()), {
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  async #ensureRunning(prefixes: SandboxMounts): Promise<void> {
    if (!this.#container.running) {
      this.#container.start({
        image: this.#container.images.sandbox,
        instance: "standard-3",
        enableInternet: false,
      });
    }
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    // Mounts do not survive a container restart, so every exec mounts; an existing
    // identical mount is reused.
    for (const mount of MOUNT_TABLE) {
      await this.#mounts.mount(this.#mountRequest(mount.path, prefixes[mount.key], mount.access));
    }
  }

  #mountRequest(
    mountPath: string,
    keyPrefix: string,
    access: "read-only" | "read-write",
  ): S3MountRequest {
    return {
      mountPath,
      source: {
        type: "s3",
        endpoint: this.env.S3_ENDPOINT,
        bucket: this.env.S3_BUCKET,
        region: this.env.S3_REGION,
        credentials: {
          type: "static",
          accessKeyId: this.env.S3_ACCESS_KEY_ID,
          secretAccessKey: this.env.S3_SECRET_ACCESS_KEY,
        },
      },
      keyPrefix,
      access,
    };
  }
}

// The port promises non-overlapping prefixes, and an empty one would mount the bucket root;
// a timeout of 0 makes `timeout` run unbounded.
function validate(request: ExecRequest): void {
  if (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds <= 0) {
    throw new Error(`invalid timeoutSeconds: ${request.timeoutSeconds}`);
  }
  const prefixes = MOUNT_TABLE.map(({ key }) => request.mounts[key]);
  for (const prefix of prefixes) {
    if (prefix === "" || prefix.startsWith("/") || prefix.endsWith("/")) {
      throw new Error(`invalid mount prefix: "${prefix}"`);
    }
  }
  for (const a of prefixes) {
    for (const b of prefixes) {
      if (a !== b && `${b}/`.startsWith(`${a}/`)) throw new Error(`overlapping mounts: ${a}, ${b}`);
    }
  }
  if (new Set(prefixes).size !== prefixes.length) throw new Error("duplicate mount prefixes");
}

function ndjson(): TransformStream<ExecChunk, Uint8Array> {
  const encoder = new TextEncoder();
  return new TransformStream({
    transform: (chunk, controller) =>
      controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`)),
  });
}

/** The Sandbox port over a RunSandbox Durable Object, named `<runId>/<name>`. */
export function durableObjectSandbox(
  namespace: DurableObjectNamespace<RunSandbox>,
  runId: string,
  name: string,
): Sandbox {
  const stub = namespace.getByName(`${runId}/${name}`);
  return {
    async *exec(request: ExecRequest, signal?: AbortSignal) {
      // Also aborted when the caller stops iterating, so the command never outlives its reader.
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort);
      try {
        // fetch(), not RPC: only fetch carries the client's abort into the Durable Object.
        const response = await stub.fetch("http://sandbox/exec", {
          method: "POST",
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        if (!response.ok || response.body === null) {
          throw new Error(`sandbox exec failed: ${response.status} ${await response.text()}`);
        }
        const decoder = new TextDecoder();
        let pending = "";
        let exited = false;
        for await (const bytes of response.body) {
          pending += decoder.decode(bytes, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            const chunk = JSON.parse(line) as ExecChunk;
            exited ||= chunk.type === "exit";
            yield chunk;
          }
        }
        // A stream that ends without an exit chunk means the container stopped mid-command.
        if (!exited) throw new Error("sandbox exec stream ended without an exit code");
      } finally {
        signal?.removeEventListener("abort", abort);
        controller.abort();
      }
    },
    async destroy() {
      await stub.fetch("http://sandbox/", { method: "DELETE" });
    },
  };
}
