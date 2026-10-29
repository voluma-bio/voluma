/**
 * A run's sandboxes, one per thread: a thread's sandbox is created on the first tool call
 * that needs it and destroyed at the end. Concurrent first calls of a thread share one
 * creation; a failed creation is forgotten, so the thread's next call tries again. A sandbox
 * the provider ended (idle timeout, lifetime) is replaced on the thread's next call: `get`
 * asks `exitCode()` about a sandbox it has handed out before (a round trip of 30-40 ms),
 * emits `stopped` and creates a new one. A sandbox `create` just returned is trusted. The
 * provider can also refuse a command while it shuts a sandbox down, with `exitCode()` still
 * null; the sandbox `get` returns then replaces the sandbox and runs the command that never
 * started once more. State changes go to `onState` with the thread they belong to (the
 * runner writes them as `sandbox` events).
 */
import { type Sandbox, SandboxEndedError } from "./ports/sandbox";

export type SandboxState = "starting" | "ready" | "stopped" | "failed";

export interface SandboxSession {
  /**
   * The calling thread's sandbox. When the thread held an earlier sandbox that has since been
   * replaced, its files outside the mounts are gone: the returned sandbox then puts the
   * restart note at the head of its next `exec` output, once, so the model reads it. A
   * thread's first call gets no note.
   */
  get(threadId: string): Promise<Sandbox>;
  /** Destroys every sandbox created; later `get` calls throw. */
  close(): Promise<void>;
}

interface Entry {
  generation: number;
  sandbox: Promise<Sandbox>;
  /** False until a `get` has returned this sandbox: one `create` just returned is alive. */
  handedOut: boolean;
}

/** One thread's sandbox: the part of the session that replaces it when the provider ends it. */
function threadSandbox(
  threadId: string,
  create: (threadId: string) => Promise<Sandbox>,
  onState: (threadId: string, state: SandboxState, detail?: string) => void,
  restartNote: string,
  assertOpen: () => void,
) {
  let current: Entry | undefined;
  let generations = 0;
  // The generation of the sandbox the thread last got.
  let lastSeen: number | undefined;

  const start = (): Entry => {
    const generation = ++generations;
    return {
      generation,
      handedOut: false,
      sandbox: (async () => {
        onState(threadId, "starting");
        try {
          const sandbox = await create(threadId);
          onState(threadId, "ready");
          return sandbox;
        } catch (error) {
          if (current?.generation === generation) current = undefined;
          onState(threadId, "failed", String(error));
          throw error;
        }
      })(),
    };
  };

  // Callers that saw the same dead sandbox: the first replaces it in this synchronous
  // step, the rest find the replacement. The replacement is trusted (just created), so a
  // call replaces at most once.
  const replace = async (dead: Entry, code?: number): Promise<Entry> => {
    assertOpen();
    if (current === dead) {
      // A refused command (`swap`) has no code.
      onState(
        threadId,
        "stopped",
        code === undefined ? "ended by the provider" : `ended by the provider (exit code ${code})`,
      );
      current = start();
      await (await dead.sandbox).destroy();
      assertOpen();
    }
    current ??= start();
    const entry = current;
    await entry.sandbox;
    assertOpen();
    return entry;
  };

  return {
    async get(): Promise<Sandbox> {
      assertOpen();
      current ??= start();
      let entry = current;
      const sandbox = await entry.sandbox;
      assertOpen();
      const code = entry.handedOut ? await sandbox.exitCode() : null;
      if (code !== null) entry = await replace(entry, code);
      entry.handedOut = true;
      const previous = lastSeen;

      let held = entry;
      // `lastSeen` moves on only once the note is yielded or none is owed, so a replacement
      // that no `exec` reports is still owed to the thread's next call.
      let needsNote = previous !== undefined && previous !== entry.generation;
      if (!needsNote) lastSeen = entry.generation;
      let noted = false;
      // A command already ran on the sandbox this call is about to lose.
      let ran = false;
      // The provider refused to start the command: replace once, and the caller runs it again.
      const swap = async () => {
        held = await replace(held);
        held.handedOut = true;
        needsNote = (previous !== undefined || ran) && !noted;
        if (!needsNote) lastSeen = held.generation;
      };
      return {
        exitCode: async () => (await held.sandbox).exitCode(),
        destroy: async () => (await held.sandbox).destroy(),
        async *exec(request, signal) {
          for (let retried = false; ; retried = true) {
            if (needsNote) {
              needsNote = false;
              noted = true;
              lastSeen = held.generation;
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
      // Whatever `current` holds after each await, including a replacement a `get` installed
      // meanwhile.
      while (current) {
        const entry = current;
        current = undefined;
        const sandbox = await entry.sandbox.catch(() => undefined);
        if (!sandbox) continue;
        await sandbox.destroy();
        onState(threadId, "stopped");
      }
    },
  };
}

/** `create` makes the sandbox for one thread; the runner picks its spec from the thread. */
export function sandboxSession(
  create: (threadId: string) => Promise<Sandbox>,
  onState: (threadId: string, state: SandboxState, detail?: string) => void,
  /** `RunLayout.restartNote`. */
  restartNote: string,
): SandboxSession {
  const threads = new Map<string, ReturnType<typeof threadSandbox>>();
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("the sandbox session is closed");
  };
  return {
    get(threadId) {
      assertOpen();
      let thread = threads.get(threadId);
      if (!thread) {
        thread = threadSandbox(threadId, create, onState, restartNote, assertOpen);
        threads.set(threadId, thread);
      }
      return thread.get();
    },
    async close() {
      closed = true;
      // Concurrent closes: one thread's slow destroy must not hold up the others'.
      await Promise.all([...threads.values()].map((t) => t.close()));
    },
  };
}
