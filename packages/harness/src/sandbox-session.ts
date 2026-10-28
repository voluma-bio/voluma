/**
 * A run's sandbox, created on the first tool call that needs it and destroyed at the
 * end. Concurrent first calls share one creation; a failed creation is forgotten, so
 * the next call tries again. A sandbox the provider ended (idle timeout, lifetime) is
 * replaced on the next call: `get` checks `alive()`, then emits `stopped` and creates a
 * new one. A sandbox is trusted until the provider's idle timeout could have passed since
 * the session last handed it out, so a busy run pays no `alive()` round trip. State
 * changes go to `onState` with the thread whose call caused them (the runner writes them
 * as `sandbox` events).
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
  /** Destroys the sandbox if one was created; later `get` calls throw. */
  close(): Promise<void>;
}

interface Entry {
  generation: number;
  threadId: string;
  sandbox: Promise<Sandbox>;
  /** False until a `get` has returned this sandbox: one `create` just returned is alive. */
  handedOut: boolean;
}

export function sandboxSession(
  create: () => Promise<Sandbox>,
  onState: (threadId: string, state: SandboxState, detail?: string) => void,
  /** The provider's idle timeout; the session skips `alive()` for this long after a hand-out. */
  idleSeconds: number,
): SandboxSession {
  // The one slot every creation goes through, so `close` sees a creation from the moment
  // it starts.
  let current: Entry | undefined;
  let closed = false;
  let generations = 0;
  let lastHandedOut = 0;
  // The generation of the sandbox each thread last got.
  const lastSeen = new Map<string, number>();

  const start = (threadId: string): Entry => {
    const generation = ++generations;
    const entry: Entry = {
      generation,
      threadId,
      handedOut: false,
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

  const assertOpen = () => {
    if (closed) throw new Error("the sandbox session is closed");
  };

  return {
    async get(threadId) {
      assertOpen();
      current ??= start(threadId);
      let entry = current;
      let sandbox = await entry.sandbox;
      assertOpen();
      const quiet = Date.now() - lastHandedOut >= idleSeconds * 1000;
      if (entry.handedOut && quiet && !(await sandbox.alive())) {
        assertOpen();
        // Callers that saw the same dead sandbox: the first replaces it in this
        // synchronous step, the rest find the replacement. The replacement is trusted
        // (it was just created), so a get replaces at most once.
        if (current === entry) {
          current = start(threadId);
          onState(threadId, "stopped", "ended by the provider");
          await sandbox.destroy();
        }
        current ??= start(threadId);
        entry = current;
        sandbox = await entry.sandbox;
        assertOpen();
      }
      entry.handedOut = true;
      lastHandedOut = Date.now();
      const previous = lastSeen.get(threadId);
      lastSeen.set(threadId, entry.generation);
      return { sandbox, restarted: previous !== undefined && previous !== entry.generation };
    },
    async close() {
      closed = true;
      // Whatever `current` holds after each await, including a replacement a `get` installed
      // meanwhile.
      while (current) {
        const entry = current;
        current = undefined;
        const sandbox = await entry.sandbox.catch(() => undefined);
        if (!sandbox) continue;
        await sandbox.destroy();
        onState(entry.threadId, "stopped");
      }
    },
  };
}
