/**
 * A run's sandbox, created on the first tool call that needs it and destroyed at the
 * end. Concurrent first calls share one creation; a failed creation is forgotten, so
 * the next call tries again. State changes go to `onState` with the thread whose call
 * caused them (the runner writes them as `sandbox` events).
 */
import type { Sandbox } from "./ports/sandbox";

export type SandboxState = "starting" | "ready" | "stopped" | "failed";

export interface SandboxSession {
  /** `threadId` is the calling thread. */
  get(threadId: string): Promise<Sandbox>;
  /** Destroys the sandbox if one was created. */
  close(): Promise<void>;
}

export function sandboxSession(
  create: () => Promise<Sandbox>,
  onState: (threadId: string, state: SandboxState, detail?: string) => void,
): SandboxSession {
  let started: { threadId: string; sandbox: Promise<Sandbox> } | undefined;
  return {
    get(threadId) {
      if (!started) {
        const current = {
          threadId,
          sandbox: (async () => {
            onState(threadId, "starting");
            try {
              const sandbox = await create();
              onState(threadId, "ready");
              return sandbox;
            } catch (error) {
              started = undefined;
              onState(threadId, "failed", String(error));
              throw error;
            }
          })(),
        };
        started = current;
      }
      return started.sandbox;
    },
    async close() {
      const current = started;
      const sandbox = await current?.sandbox.catch(() => undefined);
      if (!current || !sandbox) return;
      started = undefined;
      await sandbox.destroy();
      onState(current.threadId, "stopped");
    },
  };
}
