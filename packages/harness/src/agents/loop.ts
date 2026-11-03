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
  approvalRequestId,
  givenApprovals,
  type InboxItem,
  type Notice,
  silentMinutes,
  stalledMinutes,
} from "@voluma/contracts/agents";
import { refuseOutputsChange } from "@voluma/contracts/final-outputs";
import {
  labelMapsOf,
  type OutputCatalog,
  type OutputEntry,
} from "@voluma/contracts/output-catalog";
import { outputsFold, pendingFinal } from "@voluma/contracts/output-fold";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import type { UserSender } from "@voluma/contracts/thread-records";
import type { Interrupted } from "../adapters/pi/history-repair";
import type { BashRuntime } from "../bash-runtime";
import { failureKind, mainFailureAction, type ProviderError } from "../failure-policy";
import { LOOP_DEFAULTS, type LoopConfig, type ModelSetup } from "../loop-config";
import { loopShell, RUNTIME, type Section, type Step } from "../loop-shell";
import type { Recorder } from "../recorder";
import { threadIdOf } from "../thread-id";
import type { ThreadSpec, Threads } from "../threads";
import type { Tool, ToolResult } from "../tools/tool";
import { type ApprovedCall, approvalJobs } from "./approval-jobs";
import {
  activityReminder,
  agentList,
  briefOf,
  deliveryText,
  noticeLine,
  pingText,
  receipts,
  STUCK_REASON,
  STUCK_SUMMARY,
  WAITING_SUMMARY,
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
  pingCloseId,
  pingId,
  reportOutputId,
  returnedId,
  startedId,
} from "./effects";
import { agentLivenessNudge, cutOffText, PROVIDER_FAILED_RESUME } from "./messages";
import { skillMarker } from "./prompts";
import type { RunFiles } from "./run-files";
import type { AgentsApi } from "./tools/coordination";
import { heldText } from "./tools/gate";

/** Workers open at once (X). */
const WORKER_LIMIT = 4;

/** How often the loop looks at the clock when nothing else wakes it. */
const TICK_MS = 30_000;

/** Who an agent is when a thread is built for it. */
interface AgentIdentity {
  id: string;
  name: string;
  role: "main" | "worker";
  /** A worker's brief and the skills main named, read back from the `start_worker` call. */
  brief?: string;
  skills?: string[];
  /** The closed worker it starts from, and the worker it is blind to (`start_worker`'s `from` and `blind`). */
  from?: string;
  blind?: string;
  /** A worker's limit: the only outputs it may report (`start_worker`'s `outputs`). */
  outputs?: string[];
  /** Which main this is: 1 for the first, 2 for its replacement. */
  n: number;
  /** A replacement main in review: its first message is this (what it needs to take over), in place of the run-start prompt. */
  takeover?: string;
}

/** What the wiring decides about an agent's thread: its prompts, model and tools. */
interface AgentSetup extends ModelSetup {
  systemPrompt: string;
  /** The thread's first message; a resumed thread uses it only if it never stored one. */
  prompt: string;
  tools: Tool[];
  labelOf(sender: UserSender): string;
  interrupted: Interrupted;
}

interface AgentLoopOptions {
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
  /** Puts main's kept plan back in `/work` if it expired, before a main thread's sandbox is built (`keep-notes.ts`). */
  restoreMainPlan(): Promise<void>;
  /** Renders the agent's conversation for `/work/<name>/transcript.md` (`transcript.ts`). */
  prepareTranscript(agent: { id: string; name: string }): Promise<() => Promise<void>>;
  /** The wiring's half of building a thread: prompts, model, tools (which act through `api`). */
  setup(agent: AgentIdentity, api: AgentsApi): AgentSetup;
  /** Runs an approved call's tool, not gated, as main's thread (`tools/registry.ts` `approvedTool`). */
  approved(call: ApprovedCall, api: AgentsApi): Promise<ToolResult>;
  /** Leaves `outputId` to the researcher after a declined keep or redo; false when there is nothing to leave (`tools/keep-output.ts`). */
  leave(
    api: AgentsApi,
    threadId: string,
    eventId: string,
    outputId: string,
    labels: readonly string[],
  ): Promise<boolean>;
  /** Copies a researcher's screenshot (its stored key) into main's `/work` folder, and returns the path main reads; undefined when the file is gone. */
  stageScreenshot(snapshotKey: string): Promise<string | undefined>;
  /** The skill block (`prompts.ts` `skillBlock`) for a skill of the run's snapshot, if it has one. */
  skillBlock(name: string): string | undefined;
  config?: Partial<
    Pick<LoopConfig, "stuckLimit" | "activityMinutes" | "pingMinutes" | "pingCloseMinutes">
  >;
  providerError?(error: string): ProviderError | undefined;
  now?(): number;
  signal?: AbortSignal;
}

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
  const stuckLimit = o.config?.stuckLimit ?? LOOP_DEFAULTS.stuckLimit;
  const activityMinutes = o.config?.activityMinutes ?? LOOP_DEFAULTS.activityMinutes;
  const pingMinutes = o.config?.pingMinutes ?? LOOP_DEFAULTS.pingMinutes;
  const pingCloseMinutes = o.config?.pingCloseMinutes ?? LOOP_DEFAULTS.pingCloseMinutes;
  const now = o.now ?? Date.now;
  const derive = () => agentLog(recorder.events());
  const stateOf = (r: AgentRecord): AgentState =>
    agentState(r, threads.running(r.id) || o.bash.busy(r.id));
  /** The state by turns alone: an agent busy only with a background command takes a delivery like an idle one. */
  const turnState = (r: AgentRecord): AgentState => agentState(r, threads.running(r.id));
  /** Inbox items given to a running thread whose user message is not stored yet, by thread. */
  const handed = new Map<string, Set<string>>();
  const dealtWith = new Set<string>();
  /** When each agent was last reminded to send an activity line. */
  const reminded = new Map<string, { activityAt: number; minutes: number }>();

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
    limit: WORKER_LIMIT,
    skills: o.skills,
    catalog: o.catalog,
    prepareTranscript: o.prepareTranscript,
    startWorker: async ({
      name,
      brief,
      skills,
      from,
      blind,
      outputs,
      spawnedBy,
      parentThreadId,
    }) => {
      const id = threadIdOf(runId, name);
      await begin(
        {
          id,
          name,
          role: "worker",
          brief,
          skills,
          n: 1,
          ...(from && { from }),
          ...(blind && { blind }),
          ...(outputs && { outputs }),
        },
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

  const jobs = approvalJobs({
    recorder,
    approved: (call) => o.approved(call, api),
    leaveOutput: (threadId, eventId, outputId, labels) =>
      o.leave(api, threadId, eventId, outputId, labels),
    signal: o.signal,
    nudge: shell.nudge,
  });

  const identityOf = (d: AgentLog, r: AgentRecord): AgentIdentity => ({
    id: r.id,
    name: r.name,
    role: r.place,
    n:
      r.place === "main"
        ? [...d.records.values()].filter((x) => x.place === "main").indexOf(r) + 1
        : 1,
    ...(r.place === "worker" && briefOf(d, r)),
    ...(r.from && { from: r.from }),
    ...(r.blind && { blind: r.blind }),
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
    if (agent.role === "main") await o.restoreMainPlan();
    const s = o.setup(agent, api);
    const { systemPrompt, prompt, tools, labelOf, interrupted, ...model } = s;
    const spec = {
      ...model,
      threadId: agent.id,
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
        ...(agent.from && { from: agent.from }),
        ...(agent.blind && { blind: agent.blind }),
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
    const agent = identityOf(d, r);
    const takeover = r.place === "main" ? await takeoverOf(d, r.id, agent.n) : {};
    await begin(
      { ...agent, ...takeover },
      `${r.id}:started:${r.starts + 1}`,
      r.parentThreadId ?? root,
      {
        input: { text, sender },
        ...(takeover.takeover !== undefined && { covers: d.lastEventId }),
      },
    );
  }

  async function startup() {
    const entries = openingOutputs(o.catalog, o.selectedOutputs);
    const id = `${root}:outputs`;
    if (entries.length > 0 && !derive().written.has(id)) {
      const change = {
        by: "runner" as const,
        reason: "The outputs the researcher chose for this run.",
        add: entries,
        labels: labelMapsOf(o.catalog),
      };
      const why = refuseOutputsChange(undefined, change, o.catalog);
      if (why) throw new Error(`the run's opening outputs were refused: ${why}`);
      await recorder.append(root, "outputs.changed", change, id);
    }
    await o.runFiles.refresh();
  }

  /**
   * A replacement main in review that has stored no message: its first message is the takeover
   * text, in place of the run-start prompt (so a replacement cut off before its first message
   * is stored starts the same way again).
   */
  async function takeoverOf(d: AgentLog, id: string, n: number) {
    if (n < 2 || !d.reviewing || userTexts(id).length > 0) return {};
    return { takeover: await deliveryOf(d, id, true) };
  }

  /**
   * The next main (`main`, `main.2`, ...), skipping a name whose thread this process found
   * unresumable. A replacement in review gets the takeover prompt: its first message holds the
   * notices it would otherwise be delivered, and covers them.
   */
  async function startMain(d: AgentLog) {
    let n = [...d.records.values()].filter((r) => r.place === "main").length + 1;
    const nameOf = (k: number) => (k === 1 ? "main" : `main.${k}`);
    while (threads.stale(threadIdOf(runId, nameOf(n)))) n++;
    const id = threadIdOf(runId, nameOf(n));
    return begin(
      { id, name: nameOf(n), role: "main", n, ...(await takeoverOf(d, id, n)) },
      startedId(id),
      root,
      { ...(n > 1 && { covers: d.lastEventId }) },
    );
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

  /** A closing agent whose wrap-up turn ended is closed: its note is its last reply, or the error that ended the turn. */
  async function finishClosings(d: AgentLog): Promise<boolean> {
    for (const r of d.records.values()) {
      if (r.place !== "worker" || threads.running(r.id) || r.closeAt === undefined) continue;
      const state = stateOf(r);
      const wrappedUp = state === "closing" && r.end?.status === "completed";
      // A failed wrap-up turn ends the worker too: it is not resumed to try again.
      const failedWrapUp = state === "failed" && r.endedAt > r.closeAt;
      if (!(wrappedUp && r.endedAt > r.closeAt) && !failedWrapUp) continue;
      const note = failedWrapUp
        ? `The wrap-up turn failed: ${r.end?.error ?? "unknown error"}${r.reply ? `\n\n${r.reply}` : ""}`
        : r.reply;
      await recorder.append(
        r.id,
        "thread.ended",
        { status: "closed", ...(note && { note }) },
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
      if (threads.running(r.id) || !["idle", "closing"].includes(turnState(r))) continue;
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
   * to an idle one (or one busy only with a background command) as the start of its turn. A failed worker is woken only by main (or a wrap-up).
   */
  async function deliverInboxes(d: AgentLog): Promise<boolean> {
    let acted = false;
    for (const [id, items] of d.inbox) {
      const r = d.records.get(id);
      if (!r || r.place === "main") continue;
      const state = turnState(r);
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

  /** What the researcher wrote comes before everything else main is told. */
  const personFirst = (notices: readonly Notice[]) => [
    ...notices.filter((n) => n.kind === "person"),
    ...notices.filter((n) => n.kind !== "person"),
  ];

  /** The user messages a thread has stored, by thread: the skills it was given and whether it has a first message are read from them. */
  const userTexts = (threadId: string) =>
    recorder
      .events()
      .flatMap((e) =>
        e.type === "message" && e.threadId === threadId && e.payload.role === "user"
          ? [e.payload.text]
          : [],
      );

  /**
   * The skills a delivery to `threadId` carries, as the blocks main reads: `researcher` with the
   * first person notice the thread is told, `corrections` with the first person notice or
   * out-of-date output in review. Derived from what the thread's stored messages hold, so a
   * delivery cut off before it was stored sends them again. `all`: a takeover, which tells the
   * thread what the old one had been told too.
   */
  function skillsFor(d: AgentLog, threadId: string, all: boolean): string[] {
    const person = (all ? d.notices : d.undelivered).some((n) => n.kind === "person");
    const wanted = [
      ...(person ? ["researcher"] : []),
      ...(d.reviewing && (person || outOfDateIds().length > 0) ? ["corrections"] : []),
    ];
    if (wanted.length === 0) return [];
    const texts = userTexts(threadId);
    return wanted.flatMap((name) => {
      const block = o.skillBlock(name);
      return block && !texts.some((t) => t.includes(skillMarker(name))) ? [block] : [];
    });
  }

  /** A screenshot that cannot be staged is dropped from the delivery: the notice still carries the text. */
  async function stagedScreenshot(key: string) {
    try {
      return await o.stageScreenshot(key);
    } catch (error) {
      if (o.signal?.aborted) throw error;
      console.error(`could not stage screenshot ${key}:`, error);
      return undefined;
    }
  }

  /**
   * What main is told in its next delivery, as one text. `takeover`: the text of a replacement
   * main's first message: the notices it would be delivered, the researcher's messages the one
   * before had not answered, and the skills its predecessor had.
   */
  async function deliveryOf(d: AgentLog, threadId: string, takeover = false): Promise<string> {
    await o.runFiles.refresh();
    const events = recorder.events();
    const cut = d.cursor ? (d.written.get(d.cursor) ?? -1) : -1;
    const owed = takeover
      ? [...d.unansweredPerson.filter((n) => !d.undelivered.includes(n)), ...d.undelivered]
      : d.undelivered;
    const screenshots = new Map<string, string>();
    for (const n of owed) {
      const key = n.kind === "person" ? n.message.snapshotKey : undefined;
      const path = key && (await stagedScreenshot(key));
      if (path) screenshots.set(n.eventId, path);
    }
    return deliveryText({
      notices: personFirst(owed).map((n) => noticeLine(n, events, d.approvals, screenshots)),
      receipts: receipts(d, cut),
      agents: agentList(d, stateOf, now()),
      outOfDate: outOfDateIds(),
      pending: pendingFinal(events),
      reviewing: d.reviewing,
      skills: skillsFor(d, threadId, takeover),
    });
  }

  /**
   * Main has notices: refresh the run files and deliver them, with main's next tool result when it
   * is in a turn (a long wait must not hold a worker's report back), as a new turn when it is idle.
   * `handed` holds the covers of the send not yet stored.
   */
  async function deliverToMain(d: AgentLog): Promise<boolean> {
    const m = d.main;
    if (!m || d.undelivered.length === 0) return false;
    const state = turnState(m);
    const running = state === "working" && threads.running(m.id);
    if (!running && state !== "idle") return false;
    const covers = d.lastEventId;
    // One send at a time to a running main: until it is stored, the next would repeat its notices.
    const [outstanding] = handed.get(m.id) ?? [];
    // A start whose message is not stored yet has already taken these notices; its `onStored` nudge steps the loop again.
    if (m.inputPending) return false;
    if (running && (!covers || (outstanding && d.cursor !== outstanding))) return false;
    const text = await deliveryOf(d, m.id);
    const sender: UserSender = { kind: "runtime", covers };
    if (!running) {
      await resume(m, text, sender);
      return true;
    }
    if (!threads.send(m.id, text, sender)) return false;
    handed.set(m.id, new Set([covers as string]));
    return true;
  }

  const outOfDateIds = () =>
    outputsFold(recorder.events())
      .outputs.filter((x) => x.undecided)
      .map((x) => x.id);

  /**
   * An idle agent past the ping interval is pinged: the ping is recorded, then delivered as the
   * start of a turn. A worker already pinged with nothing received since, and idle at least
   * `pingCloseMinutes`, is asked to wrap up instead (as if it had called `close`). Main is
   * pinged only while a worker works or its own background command runs, and never closed.
   */
  async function pingIdle(d: AgentLog): Promise<boolean> {
    for (const r of d.records.values()) {
      if (r.pendingPing || r.closeAt !== undefined || r.end === undefined) continue;
      // Main's own background command makes it busy, not idle, yet it is pinged then (a worker's is not).
      const idle = r.place === "main" ? turnState(r) === "idle" : stateOf(r) === "idle";
      if (!idle || now() - Date.parse(r.endedTime) < pingMinutes * 60_000) continue;
      if (r.place === "main") {
        const somethingRuns =
          o.bash.busy(r.id) ||
          [...d.records.values()].some((x) => x.place === "worker" && stateOf(x) === "working");
        if (!somethingRuns) continue;
      } else if (r.pings > 0 && now() - r.idleFrom >= pingCloseMinutes * 60_000) {
        await recorder.append(
          r.id,
          "close.requested",
          { threadId: r.id, by: "ping" },
          pingCloseId(r.id),
        );
        return true;
      }
      let n = 1;
      while (d.written.has(pingId(r.id, n))) n++;
      await recorder.append(r.id, "ping", { threadId: r.id }, pingId(r.id, n));
      return true;
    }
    return false;
  }

  /** A recorded ping an idle agent has not received is delivered; one overtaken by other input is not (the fold clears it). */
  async function deliverPings(d: AgentLog): Promise<boolean> {
    for (const r of d.records.values()) {
      if (!r.pendingPing || threads.running(r.id) || turnState(r) !== "idle") continue;
      // Main's list may be as old as the interval: it gets the current one.
      const text =
        r.place === "main"
          ? `${pingText(pingMinutes)}\n\nAgents:\n${agentList(d, stateOf, now())}`
          : pingText(pingMinutes);
      await resume(r, text, { kind: "runtime", covers: r.pendingPing });
      return true;
    }
    return false;
  }

  /** An agent silent for a window is reminded, and again for each further window it stays silent. */
  async function remindSilent(d: AgentLog): Promise<boolean> {
    for (const r of d.records.values()) {
      if (r.closeAt !== undefined) continue;
      const silent = silentMinutes(r, threads.running(r.id), now());
      const last = reminded.get(r.id);
      // The level resets with the silence: a new activity line or start moves `activityAt`.
      const level = last?.activityAt === r.activityAt ? last.minutes : 0;
      if (silent < level + activityMinutes) continue;
      if (threads.send(r.id, activityReminder(activityMinutes), RUNTIME)) {
        reminded.set(r.id, { activityAt: r.activityAt, minutes: silent });
        return true;
      }
    }
    return false;
  }

  /** Something still holds the run open: an approved call not yet settled, or an agent working or closing that has not gone silent for two windows (R1). */
  const holdsRun = (d: AgentLog) =>
    givenApprovals(d.approvals).length > 0 ||
    [...d.records.values()].some(
      (r) =>
        ["working", "closing"].includes(stateOf(r)) &&
        stalledMinutes(r, threads.running(r.id), now()) < 2 * activityMinutes,
    );

  /**
   * Main is idle with nothing new and nothing holds the run open. In review with nothing unanswered
   * from the researcher the claim ends waiting, whether or not a request is open (the log shows
   * them; an answer reopens the run). Otherwise main is nudged a few times, then the run ends
   * stuck. Ids carry the span, so a repeat in a later span is a new end.
   */
  async function idleEnd(d: AgentLog): Promise<boolean> {
    const m = d.main;
    if (!m || stateOf(m) !== "idle" || d.undelivered.length > 0 || holdsRun(d)) return false;
    if (d.reviewing && d.unansweredPerson.length === 0) {
      await o.runFiles.refresh();
      return recorder.append(
        root,
        "thread.ended",
        { status: "completed", summary: WAITING_SUMMARY },
        `${root}:waiting:end:${d.span}`,
      );
    }
    const events = recorder.events();
    if (d.emptyDeliveries < stuckLimit) {
      const state = `Agents:\n${agentList(d, stateOf, now())}`;
      await resume(m, agentLivenessNudge(state), { kind: "runtime", covers: d.lastEventId });
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
        `${root}:stuck:outputs:${d.span}`,
      );
    }
    // Every open worker, idle ones too, is cancelled (DIVERGENCE/06): idle workers would otherwise hold the run open, and the run's report shows them closed.
    for (const r of d.records.values()) {
      if (r.place === "worker" && stateOf(r) !== "closed") {
        await recorder.append(
          r.id,
          "thread.ended",
          { status: "cancelled", note: "The run ended." },
          `${root}:stuck:end:${d.span}:${r.id}`,
        );
      }
    }
    await o.runFiles.refresh();
    return recorder.append(
      root,
      "thread.ended",
      { status: "completed", summary: STUCK_SUMMARY },
      `${root}:stuck:end:${d.span}`,
    );
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
    const jobFailure = jobs.failure();
    if (jobFailure !== undefined) throw jobFailure;
    // Review with a main that was stopped (`stopAll` after its grace): nothing would act on the researcher, so another takes over.
    if (!d.main || (d.reviewing && stateOf(d.main) === "closed")) {
      await startMain(d);
      return "acted";
    }
    if (await unresumable(d)) return "acted";
    if (await resumeCutOff(d)) return "acted";
    if (stateOf(d.main) === "failed") {
      await mainFailed(d, d.main);
      return "acted";
    }
    if (await jobs.leave(d)) return "acted";
    if (jobs.start(d)) return "acted";
    if (await finishClosings(d)) return "acted";
    if (await returnUnread(d)) return "acted";
    if (await deliverBashNotices(d)) return "acted";
    if (await deliverInboxes(d)) return "acted";
    if (await deliverToMain(d)) return "acted";
    if (await deliverPings(d)) return "acted";
    if (await pingIdle(d)) return "acted";
    if (await remindSilent(d)) return "acted";
    if (await idleEnd(d)) return "acted";
    return "idle";
  }

  o.bash.wake = shell.nudge;
  // A delivery stored for a running main frees the next one, which `deliverToMain` holds back
  // until then; no thread settling or tool call wakes the loop for it.
  // Events the API wrote into the claim (`recorder.ts`) may be what an idle loop waits for.
  recorder.onPulled(shell.nudge);
  recorder.onStored((e) => {
    if (e.type !== "message" || e.payload.role !== "user") return;
    if (e.payload.sender.kind === "runtime" && e.payload.sender.covers) shell.nudge();
  });
  // Silence is measured in minutes, and nothing else wakes an idle loop for it.
  const tick = setInterval(shell.nudge, TICK_MS);
  try {
    await shell.run(step);
  } finally {
    clearInterval(tick);
  }
}

/**
 * The result of a tool call a restart cut off, from the log, when the call took effect. Tools
 * whose event the id table names answer "completed"; the rest get the cautious default text. A
 * held call's result ends the turn, as the live one did.
 */
export function interruptedResult(
  d: AgentLog,
  threadId: string,
  tool: string,
  toolCallId: string,
): string | { text: string; terminate: true } | undefined {
  // A call held for the researcher was answered "held" and the turn ended; the hold is in the log.
  if (d.written.has(approvalRequestId(threadId, toolCallId)))
    return { text: heldText(toolCallId), terminate: true };
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
