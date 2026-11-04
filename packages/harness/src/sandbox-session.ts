/**
 * A run's sandboxes, one per thread: a thread's sandbox is created on the first tool call
 * that needs it and destroyed when the thread ends (`release`). Concurrent first calls of a thread share one
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
import { SandboxUnavailableError } from "./tools/tool";

export type SandboxState = "starting" | "ready" | "stopped" | "failed";

export interface SandboxSession {
  /**
   * The calling thread's sandbox. When the thread held an earlier sandbox that has since been
   * replaced, its files outside the mounts are gone: the returned sandbox then puts the
   * restart note at the head of its next `exec` output, once, so the model reads it. A
   * thread's first call gets no note. `{ note: false }` is for a command the host runs on its
   * own account (hashing a file): it never consumes the note, which stays owed to the
   * model's next call.
   */
  get(threadId: string, options?: { note?: boolean }): Promise<Sandbox>;
  /**
   * Destroys the sandbox the thread holds now (the supervisor calls it when the thread ends)
   * and sends `stopped`. The sandbox is detached at the call, before `beforeDestroy` runs, so a
   * thread resumed meanwhile gets a fresh sandbox and the restart note, and this release never
   * destroys it. `beforeDestroy` runs first (stopping the thread's commands). A no-op once the
   * session is closed.
   */
  release(threadId: string, beforeDestroy?: () => Promise<void>): Promise<void>;
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
          // Called after this entry is \`current\`, so a creation that throws at once is forgotten too.
          const sandbox = await Promise.resolve().then(() => create(threadId));
          onState(threadId, "ready");
          return sandbox;
        } catch (error) {
          if (current?.generation === generation) current = undefined;
          onState(threadId, "failed", String(error));
          // Every creation path (first use, a replacement mid-command) fails the same way.
          throw new SandboxUnavailableError(`the sandbox could not be started: ${String(error)}`);
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
      const fresh = start();
      current = fresh;
      // Awaited below; until then a creation that fails before the destroy returns would be an
      // unhandled rejection, which fails the whole run (the runner's handler).
      fresh.sandbox.catch(() => {});
      await (await dead.sandbox).destroy();
      assertOpen();
      // This caller's replacement, not a second one started because a failure cleared `current`.
      await fresh.sandbox;
      assertOpen();
      return fresh;
    }
    current ??= start();
    const entry = current;
    await entry.sandbox;
    assertOpen();
    return entry;
  };

  const destroyEntry = async (entry: Entry | undefined, detail?: string) => {
    const sandbox = await entry?.sandbox.catch(() => undefined);
    if (!sandbox) return;
    await sandbox.destroy();
    onState(threadId, "stopped", detail);
  };

  return {
    async get(notify: boolean): Promise<Sandbox> {
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
      const owed = previous !== undefined && previous !== entry.generation;
      let needsNote = notify && owed;
      if (!owed) lastSeen = entry.generation;
      let noted = false;
      // A command already ran on the sandbox this call is about to lose.
      let ran = false;
      // The provider refused to start the command: replace once, and the caller runs it again.
      const swap = async () => {
        held = await replace(held);
        held.handedOut = true;
        // A host-internal command leaves what the model is owed untouched.
        if (!notify) return;
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
    /**
     * Detaches the thread's current sandbox in this synchronous step, then runs `beforeDestroy`
     * and destroys that one. Destroy takes ~30 s on Modal; a `get` in that window starts its own
     * entry, which this release must not see.
     */
    release(beforeDestroy?: () => Promise<void>): Promise<void> {
      const entry = current;
      current = undefined;
      return (async () => {
        try {
          await beforeDestroy?.();
        } finally {
          // "released": the thread's previous sandbox, which may stop while a resume's new one runs.
          await destroyEntry(entry, "released");
        }
      })();
    },
    async close() {
      // Whatever `current` holds after each await, including a replacement a `get` installed
      // meanwhile.
      while (current) {
        const entry = current;
        current = undefined;
        await destroyEntry(entry);
      }
    },
  };
}

/** `create` makes the sandbox for one thread; the runner picks its spec from the thread. */
export function sandboxSession(
  create: (threadId: string) => Promise<Sandbox>,
  onState: (threadId: string, state: SandboxState, detail?: string) => void,
  /** `ThreadLayout.restartNote` of the thread. */
  restartNote: (threadId: string) => string,
): SandboxSession {
  const threads = new Map<string, ReturnType<typeof threadSandbox>>();
  const pending = new Set<Promise<void>>();
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("the sandbox session is closed");
  };
  return {
    get(threadId, options) {
      assertOpen();
      let thread = threads.get(threadId);
      if (!thread) {
        thread = threadSandbox(threadId, create, onState, restartNote(threadId), assertOpen);
        threads.set(threadId, thread);
      }
      return thread.get(options?.note !== false);
    },
    async release(threadId, beforeDestroy) {
      const thread = threads.get(threadId);
      if (closed || !thread) return;
      const releasing = thread.release(beforeDestroy);
      pending.add(releasing);
      try {
        await releasing;
      } finally {
        pending.delete(releasing);
      }
    },
    async close() {
      closed = true;
      // Concurrent closes: one thread's slow destroy must not hold up the others'. A release
      // still destroying its detached sandbox finishes before the claim ends.
      await Promise.all([
        ...[...threads.values()].map((t) => t.close()),
        ...[...pending].map((p) => p.catch(() => {})),
      ]);
    },
  };
}
