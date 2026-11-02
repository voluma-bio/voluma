/**
 * The agent model's run loop: main starts workers, they message and report, main closes them and
 * closes the run. It keeps no state the log cannot rebuild (`agentLog`): process memory is only
 * which threads run and `handed`, the inbox items given to a running thread whose user message
 * is not stored yet. One `step` at a time, inside the run's lock, does the first applicable of:
 * start main; deal with an unresumable thread; resume cut-off agents; finish closings; return
 * the unread mail of a closed agent; deliver inboxes; tell main what happened; and end a run
 * main stopped moving. The shared skeleton (wake-ups, starting a thread, stopping them all) is
 * `loop-shell.ts`.
 *
 * One delivery rule: an item is delivered once a stored user message, or a stored start's input,
 * carries its id (`contracts/agents.ts`). A resume therefore re-derives what is owed and no
 * message is lost or sent twice; `handed` only stops a second `send` before the first one's
 * message is stored, and is dropped when the thread's invocation settles.
 */
import {
  type AgentLog,
  type AgentRecord,
  type AgentState,
  agentLog,
  agentState,
  type InboxItem,
} from "@voluma/contracts/agents";
import { refuseOutputsChange } from "@voluma/contracts/final-outputs";
import type { OutputCatalog, OutputEntry } from "@voluma/contracts/output-catalog";
import { outputsFold, pendingFinal } from "@voluma/contracts/output-fold";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import type { UserSender } from "@voluma/contracts/thread-records";
import type { BashRuntime } from "../bash-runtime";
import { failureKind, mainFailureAction, type ProviderError } from "../failure-policy";
import { loopShell, type Section, type Step } from "../loop-shell";
import { cutOffText } from "../messages";
import type { Recorder } from "../recorder";
import type { ModelSetup } from "../run-loop";
import { threadIdOf } from "../thread-id";
import type { ThreadSpec, Threads } from "../threads";
import type { Tool } from "../tools/tool";
import {
  agentList,
  briefOf,
  deliveryText,
  livenessNudge,
  noticeLine,
  PROVIDER_FAILED_RESUME,
  receipts,
  STUCK_REASON,
  STUCK_SUMMARY,
  wrapUpResumeText,
  wrapUpText,
} from "./deliveries";
import {
  changeOutputsId,
  closedEndId,
  closeEventId,
  closeWorkerEndId,
  closeWorkerId,
  messageEventId,
  reportOutputId,
  returnedId,
  startedId,
} from "./effects";
import type { RunFiles } from "./run-files";
import type { AgentsApi } from "./tools/coordination";

export interface AgentLoopConfig {
  /** Workers open at once (X). */
  limit: number;
  /** Deliveries with nothing new in a row before code ends the run. */
  stuckLimit: number;
}

export const AGENT_LOOP_DEFAULTS: AgentLoopConfig = { limit: 4, stuckLimit: 2 };

/** Who an agent is when a thread is built for it. */
export interface AgentIdentity {
  id: string;
  name: string;
  role: "main" | "worker";
  /** A worker's brief and the skills main named, read back from the `start_worker` call. */
  brief?: string;
  skills?: string[];
  /** Which main this is: 1 for the first, 2 for its replacement. */
  n: number;
}

/** What the wiring decides about an agent's thread: its prompts, model and tools. */
export interface AgentSetup extends ModelSetup {
  systemPrompt: string;
  /** The thread's first message; a resumed thread uses it only if it never stored one. */
  prompt: string;
  tools: Tool[];
  labelOf(sender: UserSender): string;
  interrupted(tool: string, toolCallId: string): string | undefined;
}

export interface AgentLoopOptions {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  threads: Threads;
  section: Section;
  catalog: OutputCatalog;
  /** The outputs the researcher selected (the catalog's `selectable` ones when absent). */
  selectedOutputs: readonly string[] | undefined;
  /** The skills a brief may name. */
  skills: readonly string[];
  runFiles: RunFiles;
  /** The claim's background commands: a thread running one is not idle, and a notice for a thread that is not running restarts it. */
  bash: BashRuntime;
  /** Releases an agent's commands and sandbox once it has really ended. */
  release(threadId: string): Promise<void>;
  /** Keeps what an agent leaves in its `/work` folder past the folder's expiry (`keep-notes.ts`). */
  keepNotes(agent: { name: string; role: string }): Promise<void>;
  /** The wiring's half of building a thread: prompts, model, tools (which act through `api`). */
  setup(agent: AgentIdentity, api: AgentsApi): AgentSetup;
  config?: Partial<AgentLoopConfig>;
  providerError?(error: string): ProviderError | undefined;
  now?(): number;
  signal?: AbortSignal;
}

const RUNTIME: UserSender = { kind: "runtime" };
const BASH_NOTICE: UserSender = { kind: "runtime", notice: true };

/** The run's opening final outputs: the selected ones, or the catalog's `selectable` entries when none were chosen. */
export function openingOutputs(
  catalog: readonly OutputEntry[],
  selected: readonly string[] | undefined,
) {
  return selected
    ? catalog.filter((e) => selected.includes(e.id))
    : catalog.filter((e) => e.selectable);
}

export async function agentLoop(o: AgentLoopOptions): Promise<void> {
  const { runId, rootThreadId: root, recorder, threads } = o;
  const config = { ...AGENT_LOOP_DEFAULTS, ...o.config };
  const now = o.now ?? Date.now;
  const derive = () => agentLog(recorder.events());
  const stateOf = (r: AgentRecord): AgentState =>
    agentState(r, threads.running(r.id) || o.bash.busy(r.id));
  /** Inbox items given to a running thread whose user message is not stored yet, by thread. */
  const handed = new Map<string, Set<string>>();
  const dealtWith = new Set<string>();

  const shell = loopShell({
    rootThreadId: root,
    recorder,
    threads,
    section: o.section,
    startup,
    log: () => {
      const d = derive();
      return {
        main: d.main?.id,
        root: { endedThisClaim: d.rootEndedThisClaim },
        threads: d.records,
      };
    },
    stop: async (threadId, eventId) => {
      await recorder.append(threadId, "thread.ended", { status: "cancelled" }, eventId);
      if (threads.started(threadId)) threads.abort(threadId);
    },
    signal: o.signal,
  });

  const api: AgentsApi = {
    runId,
    rootThreadId: root,
    recorder,
    section: o.section,
    log: derive,
    state: stateOf,
    limit: config.limit,
    skills: o.skills,
    catalog: o.catalog,
    startWorker: async ({ name, brief, skills, spawnedBy, parentThreadId }) => {
      const id = threadIdOf(runId, name);
      await begin(
        { id, name, role: "worker", brief, skills, n: 1 },
        startedId(id),
        parentThreadId,
        { spawnedBy },
      );
    },
    abort: (id) => {
      if (threads.started(id)) threads.abort(id);
    },
    refreshRunFiles: o.runFiles.refresh,
    changed: shell.nudge,
  };

  const identityOf = (d: AgentLog, r: AgentRecord): AgentIdentity => ({
    id: r.id,
    name: r.name,
    role: r.place,
    n:
      r.place === "main"
        ? [...d.records.values()].filter((x) => x.place === "main").indexOf(r) + 1
        : 1,
    ...(r.place === "worker" && briefOf(d, r)),
  });

  /**
   * Stores the agent's `thread.started` (with its input, if any), then runs it. Call inside the
   * section: a stop cannot come between the append and the start.
   */
  async function begin(
    agent: AgentIdentity,
    startedEventId: string,
    parentThreadId: string,
    extra: {
      spawnedBy?: string;
      input?: { text: string; sender: UserSender };
      covers?: string;
    } = {},
  ) {
    const s = o.setup(agent, api);
    const { systemPrompt, prompt, tools, labelOf, interrupted, ...model } = s;
    const spec = {
      ...model,
      threadId: agent.id,
      kind: "agent" as const,
      agent: { name: agent.name, role: agent.role },
      systemPrompt,
      prompt,
      tools,
      labelOf,
      interrupted,
      ...(extra.covers && { promptCovers: extra.covers }),
      ...(extra.input && { input: extra.input }),
    } satisfies ThreadSpec;
    await shell.begin(
      spec,
      {
        name: agent.name,
        parentThreadId,
        kind: agent.role,
        role: agent.role,
        model: `${s.model.provider}/${s.model.id}`,
        ...(extra.spawnedBy && { spawnedBy: extra.spawnedBy }),
        ...(extra.input && { input: extra.input }),
      },
      startedEventId,
    );
    void threads.idle(agent.id).then(() => handed.delete(agent.id));
  }

  /** Resumes an agent that is not running, from its History, with a message. Never a closed one. */
  async function resume(r: AgentRecord, text: string, sender: UserSender) {
    const d = derive();
    if (stateOf(r) === "closed") throw new Error(`${r.id} is closed and is never resumed`);
    await begin(identityOf(d, r), `${r.id}:started:${r.starts + 1}`, r.parentThreadId ?? root, {
      input: { text, sender },
    });
  }

  async function startup() {
    const entries = openingOutputs(o.catalog, o.selectedOutputs);
    const id = `${root}:outputs`;
    if (entries.length > 0 && !derive().written.has(id)) {
      const change = {
        by: "runner" as const,
        reason: "The outputs the researcher chose for this run.",
        add: entries,
      };
      const why = refuseOutputsChange(undefined, change, o.catalog);
      if (why) throw new Error(`the run's opening outputs were refused: ${why}`);
      await recorder.append(root, "outputs.changed", change, id);
    }
    await o.runFiles.refresh();
  }

  /** The next main (`main`, `main.2`, ...), skipping a name whose thread this process found unresumable. */
  function startMain(d: AgentLog) {
    let n = [...d.records.values()].filter((r) => r.place === "main").length + 1;
    const nameOf = (k: number) => (k === 1 ? "main" : `main.${k}`);
    while (threads.stale(threadIdOf(runId, nameOf(n)))) n++;
    const id = threadIdOf(runId, nameOf(n));
    return begin({ id, name: nameOf(n), role: "main", n }, startedId(id), root, {
      ...(n > 1 && { covers: recorder.events().at(-1)?.id }),
    });
  }

  const failureOf = (r: AgentRecord) => failureKind(r.end, o.providerError);

  /** A fatal provider error on a thread this process ran fails the run; an earlier claim's does not. */
  function checkFatal(d: AgentLog) {
    for (const r of d.records.values()) {
      if (failureOf(r) === "fatal" && threads.started(r.id)) {
        const who = r.place === "main" ? "the AI" : `the worker ${r.name}`;
        throw new Error(`${who} stopped on an error from its provider: ${r.end?.error ?? ""}`);
      }
    }
  }

  /** A thread this process was refused as unresumable: a new main takes over, a worker is stopped and main told. */
  async function unresumable(d: AgentLog): Promise<boolean> {
    for (const r of d.records.values()) {
      const why = threads.stale(r.id);
      if (!why || dealtWith.has(r.id)) continue;
      dealtWith.add(r.id);
      if (r.place === "main") {
        if (d.main === r) {
          await startMain(d);
          return true;
        }
      } else {
        await recorder.append(
          r.id,
          "thread.ended",
          {
            status: "cancelled",
            summary: `It could not be resumed (${why}). Start a new worker for its work.`,
          },
          `${r.id}:unresumable`,
        );
        return true;
      }
    }
    return false;
  }

  /** Resumes agents a deploy cut off, main first, with the line naming the call they were in. */
  async function resumeCutOff(d: AgentLog): Promise<boolean> {
    const cut = [...d.records.values()]
      .filter((r) => stateOf(r) === "cut-off" && !threads.stale(r.id))
      .sort((a, b) => Number(b.place === "main") - Number(a.place === "main"));
    const r = cut[0];
    if (!r) return false;
    const tool = [...r.openCalls.values()].at(-1);
    const line = cutOffText(d.after as ClaimEndReason | undefined, tool);
    const wrap = r.closeAt !== undefined ? `\n\n${wrapUpResumeText(r.name)}` : "";
    // A start cut off before its input landed gives that input again, after the line; it keeps
    // the input's sender so the log still names what was delivered.
    const pending = r.inputPending;
    await resume(
      r,
      pending ? `${line}${wrap}\n\n${pending.text}` : `${line}${wrap}`,
      pending?.sender ?? RUNTIME,
    );
    return true;
  }

  /** A closing agent whose wrap-up turn ended: its note is its last reply. */
  async function finishClosings(d: AgentLog): Promise<boolean> {
    for (const r of d.records.values()) {
      if (r.place !== "worker" || stateOf(r) !== "closing" || threads.running(r.id)) continue;
      if (r.end?.status !== "completed" || r.endedAt < (r.closeAt ?? Infinity)) continue;
      await recorder.append(
        r.id,
        "thread.ended",
        { status: "closed", ...(r.reply && { note: r.reply }) },
        closedEndId(r.id),
      );
      await o.release(r.id);
      await o.keepNotes({ name: r.name, role: r.place });
      return true;
    }
    return false;
  }

  /** Messages a closed agent never read go back to their senders. */
  async function returnUnread(d: AgentLog): Promise<boolean> {
    for (const r of d.records.values()) {
      if (r.place !== "worker" || stateOf(r) !== "closed") continue;
      for (const item of d.inbox.get(r.id) ?? []) {
        const id = returnedId(item.id);
        if (item.kind !== "message" || d.written.has(id) || item.id.endsWith(":returned")) continue;
        const sender = [...d.records.values()].find((x) => x.name === item.from);
        if (sender && stateOf(sender) === "closed") continue;
        await recorder.append(
          r.id,
          "agent.message",
          {
            from: r.name,
            to: item.from,
            text: `${r.name} closed before it read your message: ${item.text}`,
          },
          id,
        );
        return true;
      }
    }
    return false;
  }

  /** An agent that is not running has background-command notices waiting: it starts a turn with them. */
  async function deliverBashNotices(d: AgentLog): Promise<boolean> {
    for (const r of d.records.values()) {
      if (threads.running(r.id) || !["idle", "closing"].includes(stateOf(r))) continue;
      const notices = o.bash.takeNotices(r.id);
      if (notices.length > 0) {
        await resume(r, notices.join("\n\n"), BASH_NOTICE);
        return true;
      }
    }
    return false;
  }

  const senderOf = (d: AgentLog, item: InboxItem): UserSender => {
    if (item.kind === "wrap-up") return { kind: "runtime", covers: item.id };
    const from =
      item.from === "main" ? d.main : [...d.records.values()].find((x) => x.name === item.from);
    return { kind: "thread", threadId: from?.id ?? root, messageId: item.id };
  };
  const textOf = (r: AgentRecord, item: InboxItem) =>
    item.kind === "wrap-up" ? wrapUpText(r.name) : item.text;

  /**
   * Gives each agent the messages it has not received: to a working one with its next tool result,
   * to an idle one as the start of its turn. A failed worker is woken only by main (or a wrap-up).
   */
  async function deliverInboxes(d: AgentLog): Promise<boolean> {
    let acted = false;
    for (const [id, items] of d.inbox) {
      const r = d.records.get(id);
      if (!r || r.place === "main") continue;
      const state = stateOf(r);
      const held = handed.get(id) ?? new Set<string>();
      const todo = items.filter(
        (i) =>
          !held.has(i.id) &&
          (state !== "failed" ||
            i.kind === "wrap-up" ||
            (i.kind === "message" && i.from === "main")),
      );
      if (todo.length === 0) continue;
      const send = (item: InboxItem) => {
        if (!threads.send(id, textOf(r, item), senderOf(d, item))) return false;
        handed.set(id, held.add(item.id));
        return true;
      };
      if (state === "working" || state === "closing") {
        if (threads.running(id)) {
          for (const item of todo) acted = send(item) || acted;
          continue;
        }
      }
      if (state === "idle" || state === "failed" || state === "closing") {
        const [first, ...rest] = todo;
        if (!first) continue;
        await resume(r, textOf(r, first), senderOf(d, first));
        handed.set(id, new Set([first.id]));
        for (const item of rest) send(item);
        return true;
      }
    }
    return acted;
  }

  /** Main is idle and has notices: refresh the run files and deliver them. */
  async function deliverToMain(d: AgentLog): Promise<boolean> {
    const m = d.main;
    if (!m || stateOf(m) !== "idle" || d.undelivered.length === 0) return false;
    await o.runFiles.refresh();
    const events = recorder.events();
    const cut = d.cursor ? (d.written.get(d.cursor) ?? -1) : -1;
    const text = deliveryText({
      notices: d.undelivered.map((n) => noticeLine(n, events)),
      receipts: receipts(d, cut),
      agents: agentList(d, stateOf, now()),
      outOfDate: outOfDateIds(),
      pending: pendingFinal(events),
    });
    await resume(m, text, { kind: "runtime", covers: events.at(-1)?.id });
    return true;
  }

  const outOfDateIds = () =>
    outputsFold(recorder.events())
      .outputs.filter((x) => x.undecided)
      .map((x) => x.id);

  /** Main is idle with nothing new: nudge it a few times, then end the run. */
  async function stuck(d: AgentLog): Promise<boolean> {
    const m = d.main;
    if (!m || stateOf(m) !== "idle" || d.undelivered.length > 0) return false;
    if ([...d.records.values()].some((r) => stateOf(r) === "working")) return false;
    const events = recorder.events();
    if (d.emptyDeliveries < config.stuckLimit) {
      const state = `Agents:\n${agentList(d, stateOf, now())}`;
      await resume(m, livenessNudge(state), { kind: "runtime", covers: events.at(-1)?.id });
      return true;
    }
    const pending = pendingFinal(events);
    if (pending.length > 0) {
      await recorder.append(
        root,
        "outputs.changed",
        {
          by: "rule",
          reason: STUCK_REASON,
          missing: pending.map((id) => ({ id, reason: STUCK_REASON })),
        },
        `${root}:stuck:outputs`,
      );
    }
    // Every open worker ends with the run: an idle one has an end already and `stopAll` skips it.
    for (const r of d.records.values()) {
      if (r.place === "worker" && stateOf(r) !== "closed") {
        await recorder.append(
          r.id,
          "thread.ended",
          { status: "cancelled", note: "The run ended." },
          `${root}:stuck:end:${r.id}`,
        );
      }
    }
    await o.runFiles.refresh();
    await recorder.append(
      root,
      "thread.ended",
      { status: "completed", summary: STUCK_SUMMARY },
      `${root}:stuck:end`,
    );
    return true;
  }

  async function mainFailed(d: AgentLog, m: AgentRecord): Promise<void> {
    const mains = [...d.records.values()].filter((r) => r.place === "main");
    const action = mainFailureAction({
      kind: failureOf(m),
      startedHere: threads.started(m.id),
      replied: m.replied,
      endBefore: m.endBefore,
      previousFailed: mains.at(-2)?.end?.status === "failed",
    });
    if (action === "fail")
      throw new Error(`the AI stopped on an error from its provider: ${m.end?.error ?? ""}`);
    if (action === "resume") await resume(m, PROVIDER_FAILED_RESUME, RUNTIME);
    else await startMain(d);
  }

  async function step(): Promise<Step> {
    await recorder.flush(); // a thread's end is stored before it is read
    const d = derive();
    if (d.rootEnded) {
      // The run is over: main's plan, and the notes of workers it ended without their own close.
      for (const r of d.records.values()) await o.keepNotes({ name: r.name, role: r.place });
      return "done";
    }
    checkFatal(d);
    if (!d.main) {
      await startMain(d);
      return "acted";
    }
    if (await unresumable(d)) return "acted";
    if (await resumeCutOff(d)) return "acted";
    if (stateOf(d.main) === "failed") {
      await mainFailed(d, d.main);
      return "acted";
    }
    if (await finishClosings(d)) return "acted";
    if (await returnUnread(d)) return "acted";
    if (await deliverBashNotices(d)) return "acted";
    if (await deliverInboxes(d)) return "acted";
    if (await deliverToMain(d)) return "acted";
    if (await stuck(d)) return "acted";
    return "idle";
  }

  o.bash.wake = shell.nudge;
  await shell.run(step);
}

/**
 * The result of a tool call a restart cut off, from the log, when the call took effect. Tools
 * whose event the id table names answer "completed"; the rest get the cautious default text.
 */
export function interruptedResult(
  d: AgentLog,
  threadId: string,
  tool: string,
  toolCallId: string,
): string | undefined {
  const ids: Record<string, string> = {
    message: messageEventId(threadId, toolCallId),
    close: closeEventId(threadId, toolCallId),
    close_worker: closeWorkerId(threadId, toolCallId),
    change_outputs: changeOutputsId(threadId, toolCallId),
    report_output: reportOutputId(threadId, toolCallId),
  };
  if (tool === "close_worker" && d.written.has(closeWorkerEndId(threadId, toolCallId))) {
    return "`close_worker` completed before the run was cut off: the worker was stopped.";
  }
  if (tool === "start_worker") {
    const started = [...d.records.values()].find(
      (r) => r.parentThreadId === threadId && r.spawnedBy === toolCallId,
    );
    return started
      ? `\`start_worker\` completed before the run was cut off: ${started.name} was started.`
      : undefined;
  }
  if (tool === "close" && d.written.has(ids.close as string)) {
    const me = d.records.get(threadId);
    return me?.place === "worker"
      ? wrapUpText(me.name)
      : "`close` completed before the run was cut off: the run is closed.";
  }
  const id = ids[tool];
  return id !== undefined && d.written.has(id)
    ? `\`${tool}\` completed before the run was cut off.`
    : undefined;
}
