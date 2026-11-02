/**
 * Long `bash` commands. A command still running after its `timeout_min` is not killed: it moves
 * to the background and reports when it ends. This is the runtime of Meridian's `managed-bash`
 * Pi extension (`meridian-cli/src/meridian/pi_runtime/extensions/managed-bash/`) with the host
 * process replaced by the thread's sandbox: the runtime holds one `exec` stream per command until
 * it ends, because Modal counts a sandbox as active only while an exec runs (a `nohup`ed process
 * would die at the idle timeout). Lost with the claim: a deploy ends the sandbox and the streams.
 *
 * One runtime per claim. Events come first: `bash.backgrounded` is stored before the agent is told
 * the command moved, `bash.ended` before its end notice goes out. The next claim ends what the
 * last one left running (`endCutOff`, `bash.ended {cutOff}`) and owes each such thread a notice.
 *
 * Notices (a command's end, the one ping for a command that runs long, a cut-off) go to
 * `deliver`: the loop's way of putting text in a running thread's inbox. A thread that is not
 * running keeps them until whoever starts it next calls `takeNotices`.
 */
import { createHash } from "node:crypto";
import type { Sandbox } from "./ports/sandbox";
import type { Recorder } from "./recorder";
import { coalescer, type ModelView, modelView, OutputBuffer } from "./tools/bash-output";

/** A command's exec has no timeout of its own; the sandbox's lifetime ends it (adapters clamp). */
const EXEC_SECONDS = 4 * 3600;
const WAIT_MIN = 10;
const OUTPUT_TAIL_CHARS = 4_000;
const COMMAND_SHOWN_CHARS = 200;
/** Exit code recorded for a command whose process died with the claim. */
const CUT_OFF_EXIT = 137;

/** Short enough to type, derived so a repeated call names the same command and events. */
export const bashIdOf = (threadId: string, toolCallId: string): string =>
  `b${createHash("sha256").update(`${threadId}:${toolCallId}`).digest("hex").slice(0, 8)}`;

export const backgroundedId = (bashId: string) => `bash:${bashId}:backgrounded`;
const endedId = (bashId: string) => `bash:${bashId}:ended`;

export interface BashStart {
  threadId: string;
  toolCallId: string;
  command: string;
  timeoutMin: number;
  background: boolean;
  sandbox: Sandbox;
  /** Where the full output goes when it is cut, and whether the thread can `read` it. */
  spillPath: string;
  canRead: boolean;
  /** Aborts the command while the call waits for it; once it is backgrounded, only `kill` does. */
  signal: AbortSignal;
  /** Live chunks for people watching, while the call waits. */
  output(stream: "stdout" | "stderr", text: string): void;
}

export type BashStarted =
  | { kind: "ended"; exit: number; view: ModelView }
  | { kind: "backgrounded"; bashId: string; reason: "asked" | "timeout"; timeoutMin: number };

export type BashManageAction = "list" | "output" | "wait" | "kill" | "detach";

export interface BashDeps {
  recorder: Recorder;
  /** Puts text in the thread's inbox; false when the thread is not running. */
  deliver(threadId: string, text: string): boolean;
  /** Aborts when the claim is cut off: nothing more is written, the next claim ends the commands. */
  cutOff: AbortSignal;
  log(message: string): void;
  /** How long a background command runs before the one follow-up ping. */
  pingMs?: number;
}

class Command {
  readonly output = new OutputBuffer();
  readonly abort = new AbortController();
  /** foreground: a call waits for it; background: reported when it ends; ended. */
  phase: "foreground" | "background" | "ended" = "foreground";
  exit = -1;
  startedAt = Date.now();
  detached = false;
  /** The agent has the result already (kill, wait, output), so no end notice follows. */
  consumed = false;
  waiters = 0;
  /** The `bash.backgrounded` write. */
  recorded: Promise<void> | undefined;
  live: ReturnType<typeof coalescer> | undefined;
  failure: unknown;
  result: { exit: number; view: ModelView } | undefined;
  pingTimer: NodeJS.Timeout | undefined;
  onForegroundDone: (() => void) | undefined;
  /** Resolves once `bash.ended` is stored (or the claim is cut off). */
  readonly ended: Promise<void>;
  readonly end: () => void;

  constructor(
    readonly id: string,
    readonly start: BashStart,
  ) {
    let end = () => {};
    this.ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    this.end = end;
  }
}

export class BashRuntime {
  readonly #deps: BashDeps;
  readonly #commands = new Map<string, Command>();
  readonly #pending = new Map<string, string[]>();

  constructor(deps: BashDeps) {
    this.#deps = deps;
  }

  /** Runs the command; returns its result, or that it moved to the background. */
  async start(o: BashStart): Promise<BashStarted> {
    const cmd = new Command(bashIdOf(o.threadId, o.toolCallId), o);
    cmd.live = coalescer(o.output);
    const stop = () => cmd.abort.abort();
    if (o.signal.aborted) stop();
    o.signal.addEventListener("abort", stop);
    void this.#pump(cmd).then(() => this.#settle(cmd));
    try {
      if (o.background) return await this.#background(cmd, "asked");
      const timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          if (cmd.phase !== "foreground") return;
          cmd.phase = "background";
          resolve(true);
        }, o.timeoutMin * 60_000);
        cmd.onForegroundDone = () => {
          clearTimeout(timer);
          resolve(false);
        };
      });
      if (timedOut) return await this.#background(cmd, "timeout");
    } finally {
      o.signal.removeEventListener("abort", stop);
    }
    if (cmd.failure !== undefined) throw cmd.failure;
    const view = await modelView(cmd.output, o.sandbox, o.spillPath, o.canRead, o.signal);
    return { kind: "ended", exit: cmd.exit, view };
  }

  /** Whether the thread has a background command running that it has not let go of. */
  busy(threadId: string): boolean {
    return [...this.#commands.values()].some(
      (c) => c.start.threadId === threadId && c.phase === "background" && !c.detached,
    );
  }

  /** Notices a thread that was not running could not take; the next input to it must carry them. */
  takeNotices(threadId: string): string[] {
    const notices = this.#pending.get(threadId) ?? [];
    this.#pending.delete(threadId);
    return notices;
  }

  /**
   * First step of a claim: ends every command the last claim left running, which died with its
   * sandbox, and owes the thread a notice for each.
   */
  async endCutOff(): Promise<void> {
    const events = this.#deps.recorder.events();
    const ended = new Set<string>();
    for (const e of events) if (e.type === "bash.ended") ended.add(e.payload.bashId);
    for (const e of events) {
      if (e.type !== "bash.backgrounded" || ended.has(e.payload.bashId)) continue;
      const { bashId, command } = e.payload;
      await this.#deps.recorder.append(
        e.threadId,
        "bash.ended",
        { bashId, exit: CUT_OFF_EXIT, output: "", cutOff: true },
        endedId(bashId),
      );
      this.#queue(
        e.threadId,
        `Background command ${bashId} was cut off when the run restarted: its process did not survive and its output is lost. Run it again if you still need it. Command: ${shown(command)}`,
      );
    }
  }

  /** The thread is ending: kills its running commands (the sandbox goes next) and waits for their ends. */
  async release(threadId: string): Promise<void> {
    const running = [...this.#commands.values()].filter(
      (c) => c.start.threadId === threadId && c.phase === "background",
    );
    for (const c of running) {
      c.consumed = true;
      c.abort.abort();
    }
    await Promise.all(running.map((c) => c.ended));
    this.#pending.delete(threadId);
  }

  /** `bash_manage`: the text the agent reads and whether the call failed. */
  async manage(
    threadId: string,
    action: BashManageAction,
    bashId: string | undefined,
    signal: AbortSignal,
  ): Promise<{ output: string; isError: boolean }> {
    if (action === "list") return { output: this.#list(threadId), isError: false };
    if (!bashId) return { output: `bash_id is required for action '${action}'`, isError: true };
    const cmd = this.#commands.get(bashId);
    if (!cmd || cmd.start.threadId !== threadId) {
      return this.#earlier(threadId, bashId, action);
    }
    switch (action) {
      case "output":
        return this.#output(cmd);
      case "wait":
        return await this.#wait(cmd, signal);
      case "kill":
        return await this.#kill(cmd);
      case "detach":
        return this.#detach(cmd);
    }
  }

  async #pump(cmd: Command): Promise<void> {
    const { sandbox, command } = cmd.start;
    try {
      for await (const chunk of sandbox.exec(
        { command, timeoutSeconds: EXEC_SECONDS },
        cmd.abort.signal,
      )) {
        if (chunk.type === "exit") {
          cmd.exit = chunk.code;
          continue;
        }
        cmd.output.add(chunk.data);
        cmd.live?.add(chunk.type, chunk.data);
      }
    } catch (error) {
      cmd.failure = error;
    }
    cmd.live?.flush();
  }

  /** The stream is over: a foreground call takes the result itself; a background command is recorded. */
  async #settle(cmd: Command): Promise<void> {
    if (cmd.phase === "foreground") {
      cmd.phase = "ended";
      cmd.onForegroundDone?.();
      cmd.end();
      return;
    }
    const { threadId, sandbox, spillPath, canRead } = cmd.start;
    clearTimeout(cmd.pingTimer);
    try {
      await cmd.recorded;
      if (this.#deps.cutOff.aborted) return;
      if (cmd.failure !== undefined)
        cmd.output.add(`\n[command stream failed: ${String(cmd.failure)}]\n`);
      const view = await modelView(cmd.output, sandbox, spillPath, canRead);
      await this.#deps.recorder.append(
        threadId,
        "bash.ended",
        { bashId: cmd.id, exit: cmd.exit, output: view.output },
        endedId(cmd.id),
      );
      cmd.result = { exit: cmd.exit, view };
      cmd.phase = "ended";
      if (!cmd.detached && !cmd.consumed && cmd.waiters === 0) {
        this.#queue(threadId, endNotice(cmd.id, cmd.start.command, cmd.result));
      }
    } catch (error) {
      // The write failed or the backgrounding was refused; the recorder fails the run on a store
      // that gave up, and a refused backgrounding was thrown to its caller.
      this.#deps.log(`ending background command ${cmd.id}: ${String(error)}`);
    } finally {
      cmd.phase = "ended";
      cmd.end();
    }
  }

  /** Stores `bash.backgrounded`, and only then lets the caller tell the agent. */
  async #background(cmd: Command, reason: "asked" | "timeout"): Promise<BashStarted> {
    cmd.phase = "background";
    cmd.live?.flush();
    cmd.live = undefined;
    this.#commands.set(cmd.id, cmd);
    const { threadId, command, timeoutMin } = cmd.start;
    cmd.recorded = this.#deps.recorder.append(
      threadId,
      "bash.backgrounded",
      { bashId: cmd.id, command },
      backgroundedId(cmd.id),
    );
    try {
      await cmd.recorded;
    } catch (error) {
      cmd.abort.abort();
      throw error;
    }
    this.#armPing(cmd);
    return { kind: "backgrounded", bashId: cmd.id, reason, timeoutMin };
  }

  #armPing(cmd: Command): void {
    if (cmd.phase !== "background") return;
    const ms = this.#deps.pingMs ?? 30 * 60_000;
    cmd.pingTimer = setTimeout(() => {
      if (cmd.phase !== "background" || cmd.detached) return;
      this.#queue(
        cmd.start.threadId,
        `Background command ${cmd.id} is still running after ${Math.round(ms / 60_000)} minutes: ${shown(cmd.start.command)}\nUse bash_manage wait, output, kill or detach when you are ready.`,
      );
    }, ms);
    cmd.pingTimer.unref();
  }

  #queue(threadId: string, text: string): void {
    if (this.#deps.deliver(threadId, text)) return;
    this.#pending.set(threadId, [...(this.#pending.get(threadId) ?? []), text]);
  }

  #list(threadId: string): string {
    const rows = [...this.#commands.values()].filter((c) => c.start.threadId === threadId);
    if (rows.length === 0) return "No background commands.";
    return rows
      .map((c) => {
        const state =
          c.phase === "ended"
            ? `exit ${c.result?.exit ?? c.exit}`
            : c.detached
              ? "running, detached"
              : "running";
        return `${c.id}  ${state}  ${seconds(c)}s  ${shown(c.start.command)}`;
      })
      .join("\n");
  }

  #output(cmd: Command): { output: string; isError: boolean } {
    if (cmd.phase === "ended" && cmd.result) {
      cmd.consumed = true;
      return endedText(cmd.id, cmd.result);
    }
    const tail = cmd.output.recent(OUTPUT_TAIL_CHARS);
    return {
      output: `${cmd.id}: running for ${seconds(cmd)}s. Last output:\n${tail || "(no output yet)"}`,
      isError: false,
    };
  }

  async #wait(cmd: Command, signal: AbortSignal): Promise<{ output: string; isError: boolean }> {
    cmd.waiters++;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (cmd.phase === "background") {
        await Promise.race([
          cmd.ended,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, WAIT_MIN * 60_000);
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
      }
    } finally {
      clearTimeout(timer);
      cmd.waiters--;
    }
    if (cmd.phase === "ended" && cmd.result) {
      cmd.consumed = true;
      return endedText(cmd.id, cmd.result);
    }
    return {
      output: `${cmd.id} is still running after ${seconds(cmd)}s. Call bash_manage wait again, or kill to stop it; its end is reported either way.`,
      isError: false,
    };
  }

  async #kill(cmd: Command): Promise<{ output: string; isError: boolean }> {
    if (cmd.phase === "ended") {
      return {
        output: `${cmd.id} already ended (exit ${cmd.result?.exit ?? cmd.exit})`,
        isError: true,
      };
    }
    cmd.consumed = true;
    cmd.abort.abort();
    await cmd.ended;
    return { output: `${cmd.id} killed (exit ${cmd.exit})`, isError: false };
  }

  #detach(cmd: Command): { output: string; isError: boolean } {
    if (cmd.phase === "ended") {
      return {
        output: `${cmd.id} already ended (exit ${cmd.result?.exit ?? cmd.exit})`,
        isError: true,
      };
    }
    cmd.detached = true;
    clearTimeout(cmd.pingTimer);
    return {
      output: `${cmd.id} detached: it keeps running, but its end and the follow-up ping are not reported, and it no longer counts as work in progress.`,
      isError: false,
    };
  }

  /** A command of an earlier claim is known only from the log. */
  #earlier(
    threadId: string,
    bashId: string,
    action: BashManageAction,
  ): { output: string; isError: boolean } {
    const events = this.#deps.recorder.events();
    const started = events.find(
      (e) =>
        e.type === "bash.backgrounded" && e.threadId === threadId && e.payload.bashId === bashId,
    );
    const ended = events.find((e) => e.type === "bash.ended" && e.payload.bashId === bashId);
    if (started?.type !== "bash.backgrounded" || ended?.type !== "bash.ended") {
      return { output: `bash_id not found: ${bashId}`, isError: true };
    }
    if (action !== "output" && action !== "wait") {
      return { output: `${bashId} already ended (exit ${ended.payload.exit})`, isError: true };
    }
    return ended.payload.cutOff
      ? {
          output: `${bashId} was cut off when the run restarted; its process and output are lost.`,
          isError: true,
        }
      : endedText(bashId, {
          exit: ended.payload.exit,
          view: { output: ended.payload.output, truncated: false },
        });
  }
}

const seconds = (c: Command) => Math.round((Date.now() - c.startedAt) / 1000);

const shown = (command: string) =>
  command.length > COMMAND_SHOWN_CHARS ? `${command.slice(0, COMMAND_SHOWN_CHARS)}…` : command;

function endedText(
  bashId: string,
  result: { exit: number; view: ModelView },
): { output: string; isError: boolean } {
  return {
    output: `${bashId}: ended (exit code ${result.exit})\n${result.view.output}`,
    isError: result.exit !== 0,
  };
}

const endNotice = (bashId: string, command: string, result: { exit: number; view: ModelView }) =>
  `Background command ${bashId} ended (exit code ${result.exit}): ${shown(command)}\n${result.view.output}`;
