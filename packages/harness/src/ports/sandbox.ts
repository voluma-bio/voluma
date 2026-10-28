/**
 * The Sandbox port: what the harness's tools need from an isolated machine. A
 * sandbox is created from a spec, runs commands that stream their output, and is
 * destroyed. Runtime-neutral (no Node or Worker types); the Modal adapter is
 * apps/runner/src/modal-sandbox.ts.
 */

/** An R2 key prefix, mounted into the sandbox at `path`. */
export interface SandboxMount {
  /** Absolute path in the sandbox, e.g. `/inputs`. */
  path: string;
  /**
   * Key prefix in the run's bucket, with a trailing slash and no leading one. Mounts of
   * one sandbox must not overlap, and an empty prefix (the bucket root) is invalid.
   */
  prefix: string;
  access: "read-only" | "read-write";
  /**
   * Read-only only: copy the files to local disk at `path` when the sandbox is created,
   * so commands read `path` as a local directory. Mounted reads cost a round trip per
   * file; analysis code wants local reads.
   */
  stage?: boolean;
}

export interface SandboxSpec {
  runId: string;
  /**
   * Unique within the run. The sandbox is named `<runId>.<name>.<random>`: each creation
   * gets its own name, so a sandbox a dead process left behind never blocks a resume.
   */
  name: string;
  /** A published image name; sandbox start never builds an image. */
  image: string;
  cpu: number;
  memoryMiB: number;
  /** e.g. `T4`. Absent: CPU only. */
  gpu?: string;
  mounts: SandboxMount[];
  /** Set on every command; secrets do not belong here. */
  env?: Record<string, string>;
  /**
   * Safety net: the provider ends the sandbox about this long after creation, give or
   * take (Modal enforces it loosely). The real limits are the supervisor's budget and
   * explicit `destroy()`.
   */
  lifetimeSeconds: number; // whole seconds
  /** End the sandbox after this long with no command running. */
  idleSeconds?: number;
}

export interface ExecRequest {
  /** Run with `bash -c`, in its own process group. */
  command: string;
  /** Whole seconds, at least 1. SIGTERM to the whole group when they pass, SIGKILL 5 s later. */
  timeoutSeconds: number;
  /** Added to the sandbox's env for this command. */
  env?: Record<string, string>;
}

export type ExecChunk =
  | { type: "stdout" | "stderr"; data: string }
  /** Last chunk. 124: the timeout ended the command; 143 or 137: it was killed (abort, or it ignored SIGTERM). */
  | { type: "exit"; code: number };

export interface Sandbox {
  /**
   * Runs the command and streams its output. Aborting `signal` kills the command and
   * everything it started; the stream then ends with an exit chunk.
   */
  exec(request: ExecRequest, signal?: AbortSignal): AsyncIterable<ExecChunk>;
  /**
   * Writes `bytes` to `path` in one go, creating parent directories. Works on a
   * read-write mount, which cannot append. Aborting `signal` rejects.
   */
  writeFile(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  destroy(): Promise<void>;
}

export type CreateSandbox = (spec: SandboxSpec) => Promise<Sandbox>;
