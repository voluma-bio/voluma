/**
 * A run's sandbox, created on the first tool call that needs it and destroyed at the
 * end. Concurrent first calls share one creation; a failed creation is forgotten, so
 * the next call tries again. A sandbox the provider ended (idle timeout, lifetime) is
 * replaced on the next call: `get` asks `alive()` about every sandbox it has handed out
 * before (a round trip of 30-40 ms), emits `stopped` and creates a new one. A sandbox
 * `create` just returned is trusted. The provider can also refuse a command while it
 * shuts a sandbox down, with `alive()` still true; the sandbox `get` returns then replaces
 * the sandbox and runs the command that never started once more. State changes go to
 * `onState` with the thread whose call caused them (the runner writes them as `sandbox`
 * events).
 */
import { type Sandbox, SandboxEndedError } from "./ports/sandbox";

export type SandboxState = "starting" | "ready" | "stopped" | "failed";

export interface SandboxSession {
  /**
   * `threadId` is the calling thread. When this thread held an earlier sandbox that has
   * since been replaced, its files outside the mounts are gone: the returned sandbox then
   * puts the restart note at the head of its next `exec` output, once, so the model reads
   * it. A thread's first call gets no note.
   */
  get(threadId: string): Promise<Sandbox>;
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
  /** `RunLayout.restartNote`. */
  restartNote: string,
): SandboxSession {
  // The one slot every creation goes through, so `close` sees a creation from the moment
  // it starts.
  let current: Entry | undefined;
  let closed = false;
  let generations = 0;
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

  // Callers that saw the same dead sandbox: the first replaces it in this synchronous
  // step, the rest find the replacement. The replacement is trusted (just created), so a
  // call replaces at most once.
  const replace = async (dead: Entry, threadId: string): Promise<Entry> => {
    assertOpen();
    if (current === dead) {
      onState(threadId, "stopped", "ended by the provider");
      current = start(threadId);
      await (await dead.sandbox).destroy();
      assertOpen();
    }
    current ??= start(threadId);
    const entry = current;
    await entry.sandbox;
    assertOpen();
    return entry;
  };

  return {
    async get(threadId) {
      assertOpen();
      current ??= start(threadId);
      let entry = current;
      const sandbox = await entry.sandbox;
      assertOpen();
      if (entry.handedOut && !(await sandbox.alive())) entry = await replace(entry, threadId);
      entry.handedOut = true;
      const previous = lastSeen.get(threadId);

      let held = entry;
      // `lastSeen` moves on only once the note is yielded or none is owed, so a replacement
      // that no `exec` reports is still owed to the thread's next call.
      let needsNote = previous !== undefined && previous !== entry.generation;
      if (!needsNote) lastSeen.set(threadId, entry.generation);
      let noted = false;
      // A command already ran on the sandbox this call is about to lose.
      let ran = false;
      // The provider refused to start the command: replace once, and the caller runs it again.
      const swap = async () => {
        held = await replace(held, threadId);
        held.handedOut = true;
        needsNote = (previous !== undefined || ran) && !noted;
        if (!needsNote) lastSeen.set(threadId, held.generation);
      };
      return {
        alive: async () => (await held.sandbox).alive(),
        destroy: async () => (await held.sandbox).destroy(),
        async *exec(request, signal) {
          for (let retried = false; ; retried = true) {
            if (needsNote) {
              needsNote = false;
              noted = true;
              lastSeen.set(threadId, held.generation);
              yield { type: "stderr", data: `${restartNote}\n` };
            }
            let started = false;
            try {
              for await (const chunk of (await held.sandbox).exec(request, signal)) {
                started = true;
                yield chunk;
              }
              ran = true;
              return;
            } catch (error) {
              if (started || retried || !(error instanceof SandboxEndedError)) throw error;
              await swap();
            }
          }
        },
        async writeFile(path, bytes, signal) {
          try {
            await (await held.sandbox).writeFile(path, bytes, signal);
          } catch (error) {
            if (!(error instanceof SandboxEndedError)) throw error;
            await swap();
            await (await held.sandbox).writeFile(path, bytes, signal);
          }
        },
      };
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
