/**
 * Interfaces both API domains depend on (blob storage, the thread store, the
 * sandbox). Adapters are chosen in index.ts. Owned by both lanes; change in
 * small PRs.
 */

/** R2 key prefixes (no leading or trailing slash) that a sandbox mounts. They must not overlap. */
export interface SandboxMounts {
  /** `/workflow`, read-only */
  workflow: string;
  /** `/inputs`, read-only */
  inputs: string;
  /** `/scratch`, read-write */
  scratch: string;
  /** `/outputs`, read-write */
  outputs: string;
}

export interface ExecRequest {
  /** The thread whose tool call this is; the sandbox's lifecycle events belong to it. */
  threadId: string;
  command: string;
  /** Kills the command with SIGTERM, then SIGKILL after 5 s, when this many seconds pass. */
  timeoutSeconds: number;
  /** Exactly what the command sees besides PATH and HOME. */
  env?: Record<string, string>;
  mounts: SandboxMounts;
}

export type ExecChunk =
  | { type: "stdout" | "stderr"; data: string }
  /** Last chunk. 124: the timeout killed the command; 143: the caller aborted it; 137: the command ignored SIGTERM and was SIGKILLed. */
  | { type: "exit"; code: number };

/** One sandbox of a run: a container with the run's R2 prefixes mounted. */
export interface Sandbox {
  /**
   * Starts the container and mounts on first use, runs the command, and streams its
   * output. Aborting `signal` kills the command.
   */
  exec(request: ExecRequest, signal?: AbortSignal): AsyncIterable<ExecChunk>;
  destroy(): Promise<void>;
}
