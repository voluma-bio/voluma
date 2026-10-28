/**
 * A run's sandbox, created on the first tool call that needs it and destroyed at the
 * end. Concurrent first calls share one creation. State changes go to `onState`
 * (the runner writes them as `sandbox` events).
 */
import type { Sandbox } from "./ports/sandbox";

export type SandboxState = "starting" | "ready" | "stopped" | "failed";

export interface SandboxSession {
  get(): Promise<Sandbox>;
  /** Destroys the sandbox if one was created. */
  close(): Promise<void>;
}

export function sandboxSession(
  create: () => Promise<Sandbox>,
  onState: (state: SandboxState, detail?: string) => Promise<void>,
): SandboxSession {
  let started: Promise<Sandbox> | undefined;
  return {
    get() {
      started ??= (async () => {
        await onState("starting");
        try {
          const sandbox = await create();
          await onState("ready");
          return sandbox;
        } catch (error) {
          await onState("failed", String(error));
          throw error;
        }
      })();
      return started;
    },
    async close() {
      const sandbox = await started?.catch(() => undefined);
      if (!sandbox) return;
      await sandbox.destroy();
      await onState("stopped");
    },
  };
}
