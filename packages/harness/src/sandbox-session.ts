/**
 * A run's sandbox, created on the first tool call that needs it and destroyed at the
 * end. Concurrent first calls share one creation; a failed creation is forgotten, so
 * the next call tries again. A sandbox the provider ended (idle timeout, lifetime) is
 * replaced on the next call: `get` checks `alive()` first, then emits `stopped` and
 * creates a new one. State changes go to `onState` with the thread whose call caused
 * them (the runner writes them as `sandbox` events).
 */
import type { Sandbox } from "./ports/sandbox";

export type SandboxState = "starting" | "ready" | "stopped" | "failed";

export interface SandboxSession {
  /**
   * `threadId` is the calling thread. `restarted` is true when this thread held an
   * earlier sandbox that has since been replaced: its files outside the mounts are gone,
   * so tell the model (`RunLayout.restartNote`). It is true once per replacement per
   * thread, and false on a thread's first call.
   */
  get(threadId: string): Promise<{ sandbox: Sandbox; restarted: boolean }>;
  /** Destroys the sandbox if one was created. */
  close(): Promise<void>;
}

interface Entry {
  generation: number;
  threadId: string;
  sandbox: Promise<Sandbox>;
}

export function sandboxSession(
  create: () => Promise<Sandbox>,
  onState: (threadId: string, state: SandboxState, detail?: string) => void,
): SandboxSession {
  let current: Entry | undefined;
  let generations = 0;
  // The generation of the sandbox each thread last got.
  const lastSeen = new Map<string, number>();

  const start = (threadId: string): Entry => {
    const generation = ++generations;
    const entry: Entry = {
      generation,
      threadId,
      sandbox: (async () => {
        onState(threadId, "starting");
        try {
          const sandbox = await create();
          onState(threadId, "ready");
          return sandbox;
        } catch (error) {
          if (current?.generation === generation) current = undefined;
          onState(threadId, "failed", String(error));
          throw error;
        }
      })(),
    };
    return entry;
  };

  return {
    async get(threadId) {
      for (;;) {
        current ??= start(threadId);
        const entry = current;
        const sandbox = await entry.sandbox;
        if (await sandbox.alive()) {
          const previous = lastSeen.get(threadId);
          lastSeen.set(threadId, entry.generation);
          return { sandbox, restarted: previous !== undefined && previous !== entry.generation };
        }
        // Callers that saw the same dead sandbox: the first one clears it, the rest find
        // the replacement on the next pass.
        if (current === entry) {
          current = undefined;
          onState(entry.threadId, "stopped", "ended by the provider");
          await sandbox.destroy();
        }
      }
    },
    async close() {
      const entry = current;
      const sandbox = await entry?.sandbox.catch(() => undefined);
      if (!entry || !sandbox) return;
      current = undefined;
      await sandbox.destroy();
      onState(entry.threadId, "stopped");
    },
  };
}
