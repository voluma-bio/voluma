/**
 * Test support for `run-loop.test.ts`: a whole run on the real harness (`superviseRun`, Pi's agent
 * loop, the fold) with only the model scripted (Pi's `fauxProvider`) and the stores and sandbox
 * replaced by in-memory adapters of the harness's own ports. A `world` keeps the stored events
 * and thread histories across claims, so a restart is what the runner does: abort the signal,
 * build a new recorder on the stored events, run again.
 *
 * A script is a function of the `Turn` a thread is on; it returns the model's reply: text, or
 * tool calls. It may return undefined to leave the turn to the next script (`first`).
 */
import {
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { RunEvent } from "@voluma/contracts/events";
import { corrections, type Folded } from "@voluma/contracts/fold";
import { cancelEnds } from "@voluma/contracts/threads";
import type { WorkflowFiles } from "@voluma/contracts/workflow-files";
import type { AgentDefinition, WorkflowDefinition } from "@voluma/workflow/definition";
import { EvidenceNotFound } from "./ports/evidence";
import { recorder } from "./recorder";
import { type LoopConfig, type PlanTask, superviseRun } from "./supervise-run";

export const RUN = "r1";

export interface Call {
  name: string;
  input: unknown;
}
export type Reply = string | Call | Call[];
export const call = (name: string, input: unknown = {}): Call => ({ name, input });

/** One model request: the thread asking and what its history holds. */
export interface Turn {
  thread: string;
  /** The thread's role and, for a worker or checker, its task. */
  role: "main" | "worker" | "check";
  task: string | undefined;
  /** The text of every user message, in order. */
  users: string[];
  lastUser: string;
  /** The last message is a user message: the thread starts or resumes a turn. */
  fresh: boolean;
  /** Aborts when the thread is stopped or the claim is cut off. */
  signal: AbortSignal | undefined;
  /** Tool results since the last user message (0 on the first request of a turn). */
  steps: number;
  /** Every tool call the thread has made so far, in order. */
  calls: { name: string; input: any }[];
  /** The text of every tool result so far. */
  results: string[];
}

export type Script = (t: Turn) => Reply | undefined | Promise<Reply | undefined>;

/** The first script that has a reply. */
export const first =
  (...scripts: Script[]): Script =>
  async (t) => {
    for (const s of scripts) {
      const r = await s(t);
      if (r !== undefined) return r;
    }
    return undefined;
  };

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : ((content as { text?: string }[] | undefined) ?? []).map((b) => b.text ?? "").join("");

function turnOf(
  messages: any[],
  who: Pick<Turn, "thread" | "role" | "task">,
  signal: AbortSignal | undefined,
): Turn {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const users = messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  return {
    ...who,
    signal,
    users,
    lastUser: users.at(-1) ?? "",
    fresh: messages.at(-1)?.role === "user",
    steps: messages.slice(lastUserIdx + 1).filter((m) => m.role === "toolResult").length,
    calls: messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content.filter((b: any) => b.type === "toolCall"))
      .map((b: any) => ({ name: b.name, input: b.arguments })),
    results: messages.filter((m) => m.role === "toolResult").map((m) => textOf(m.content)),
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A model request that never answers: the thread is running until it is stopped. */
export const hang = (t: Turn): Promise<never> =>
  new Promise((_, reject) => {
    t.signal?.addEventListener("abort", () =>
      reject(new Error("stopped while waiting for the model")),
    );
  });

// ---- the scripted agents

export const measurement = (value: number) => ({
  kind: "measurement",
  value,
  unit: "mm",
  confidence: null,
});

/** A worker: report `m1`, submit, then say it is done. A worker re-asked reports a new value. */
export const worker: Script = (t) => {
  const task = t.task as string;
  if (t.steps === 0) {
    const reported = t.calls.filter((c) => c.name === "report_output").length;
    return call("report_output", {
      taskId: task,
      outputId: "m1",
      title: "M",
      output: measurement(1.5 + reported),
      evidence: [],
    });
  }
  if (t.steps === 1) return call("submit_task", { taskId: task, summary: `${task} measured.` });
  return "Done.";
};

/**
 * A checker: its verdict is `verdicts(taskId, n)` for the n-th check thread of the task (1-based),
 * written as a checkpoint on its first request, then it says so.
 */
export function checker(
  verdicts: (taskId: string, n: number) => "passed" | "needs-review" = () => "passed",
): Script {
  const rounds = new Map<string, number>();
  const verdictOf = new Map<string, string>();
  return (t) => {
    const task = t.task as string;
    if (!verdictOf.has(t.thread)) {
      const n = (rounds.get(task) ?? 0) + 1;
      rounds.set(task, n);
      verdictOf.set(t.thread, verdicts(task, n));
    }
    if (t.steps === 0) {
      const verdict = verdictOf.get(t.thread);
      return call("checkpoint", {
        taskId: task,
        text: `${task} re-derived.`,
        summary: `${task} looks ${verdict}.`,
        evidence: [],
        verdict,
      });
    }
    return "Verdict written.";
  };
}

/** The ids of the asks main was told about (`askId <id>)`) and has not answered. */
export function openAskIds(t: Turn): string[] {
  const asked = t.users.flatMap((u) =>
    [...u.matchAll(/askId (\S+)\)/g)].map((m) => m[1] as string),
  );
  const answered = t.calls.filter((c) => c.name === "answer").map((c) => c.input.askId);
  return asked.filter((id) => !answered.includes(id));
}

// ---- the world

export interface WorldOptions {
  plan: PlanTask[];
  main: Script;
  worker?: Script;
  check?: Script;
  /** Tools main holds beyond the usual (e.g. `report_output`, `submit_task` to do a task itself). */
  mainTools?: string[];
  workerTools?: string[];
  config?: Partial<LoopConfig>;
  /** Once, the first time this holds for a newly stored event: the claim is cut off (aborted) there, and later events are not stored. */
  cutAfter?: (e: RunEvent) => boolean;
  /** Once, like `cutAfter`, but a user's cancel: the server then stores the ends (`cancelEnds`) and the run is never claimed again. */
  cancelAfter?: (e: RunEvent) => boolean;
  /** Milliseconds the store takes to accept an event (to hold a runtime section open at a chosen moment). */
  delayStore?: (e: RunEvent) => number;
  /** Milliseconds a thread's history takes to load (to hold a resume in its start-up at a chosen moment). */
  delayLoad?: (threadId: string) => number;
  /** Whether a failed thread's error text says the model provider failed. */
  providerError?: (error: string) => "retry" | "fatal" | undefined;
  /** Whether evidence storage holds this file (default: every file); `keep` rejects with `EvidenceNotFound` otherwise. */
  evidenceExists?: (root: "outputs" | "scratch", taskId: string, path: string) => boolean;
  /** Runs for every event the store accepts (for tests that need something to happen at that moment). */
  onStored?: (e: RunEvent) => void;
}

export const task = (
  id: string,
  dependsOn: string[] = [],
  output: { required?: boolean } = {},
): PlanTask => ({
  id,
  dependsOn,
  instructions: "do it",
  outputs: [
    { id: "m1", required: output.required ?? true, kind: "measurement", unit: "mm", on: [] },
  ],
});

export function world(o: WorldOptions) {
  const stored: RunEvent[] = [];
  const history = new Map<string, string[]>();
  let abort = new AbortController();
  let cut = false;
  let cancelled = false;
  let frozen = false;
  let n = 0;
  const callId = () => `c${++n}`;

  const models = createModels();
  const providers = (["main", "worker", "check"] as const).map((role) => {
    const p = fauxProvider({ provider: `faux-${role}`, api: `faux-${role}` });
    models.setProvider(p.provider);
    return p;
  });
  const [mainP, workerP, checkP] = providers as [
    (typeof providers)[number],
    (typeof providers)[number],
    (typeof providers)[number],
  ];
  const factory =
    (script: Script, role: Turn["role"]): FauxResponseFactory =>
    async (ctx, options) => {
      const thread = options?.sessionId as string;
      const started = stored.find((e) => e.type === "thread.started" && e.threadId === thread);
      const task = started?.type === "thread.started" ? started.payload.task : undefined;
      const turn = turnOf(ctx.messages as any[], { thread, role, task }, options?.signal);
      const reply = await script(turn);
      if (reply === undefined)
        throw new Error(`no scripted reply for ${turn.thread} (${turn.steps} steps)`);
      if (typeof reply === "string") return fauxAssistantMessage(reply);
      return fauxAssistantMessage(
        [reply].flat().map((c) => fauxToolCall(c.name, c.input as never, { id: callId() })),
      );
    };
  mainP.setResponses(Array(400).fill(factory(o.main, "main")));
  workerP.setResponses(Array(400).fill(factory(o.worker ?? worker, "worker")));
  checkP.setResponses(Array(400).fill(factory(o.check ?? checker(), "check")));

  const agent = (name: string, tools: string[]): AgentDefinition => ({
    name,
    description: "",
    model: "faux",
    tools,
    subagents: [],
    skills: [],
    body: `The ${name} of a scripted run.`,
  });
  const definition: WorkflowDefinition = {
    dir: "workflows/mouse-oa",
    commit: "a".repeat(40),
    files: { tasks: [], outputs: [] } as unknown as WorkflowFiles,
    skills: [],
    toolIndex: [],
    agents: {
      main: agent("main", [
        "start_worker",
        "message",
        "wait",
        "stop_worker",
        "answer",
        "accept",
        "change_plan",
        "reply",
        "finish_run",
        ...(o.mainTools ?? []),
      ]),
      worker: agent("worker", ["report_output", "submit_task", ...(o.workerTools ?? [])]),
      check: agent("check", ["checkpoint", "ask"]),
    },
  };
  const modelOf = { main: mainP, worker: workerP, check: checkP };

  const store = {
    append: async (e: { id: string } & Record<string, unknown>) => {
      const ms = o.delayStore?.(e as unknown as RunEvent) ?? 0;
      if (ms > 0) await sleep(ms);
      if (frozen) return;
      if (stored.some((s) => s.id === e.id)) return;
      const event = { ...e, seq: stored.length + 1 } as unknown as RunEvent;
      stored.push(event);
      o.onStored?.(event);
      if (!cut && o.cutAfter?.(event)) {
        cut = true;
        frozen = true;
        abort.abort();
      }
      if (!cancelled && o.cancelAfter?.(event)) {
        cancelled = cut = frozen = true;
        abort.abort();
        for (const ended of cancelEnds(RUN, stored, new Date())) {
          stored.push({ ...ended, seq: stored.length + 1 } as unknown as RunEvent);
        }
        // A cancel inside a correction also records how it ended (`correction.ended`).
        const { open } = corrections(stored);
        if (open) {
          stored.push({
            id: open.reopenId.replace(/:reopened$/, ":ended"),
            runId: RUN,
            threadId: `${RUN}.person`,
            seq: stored.length + 1,
            type: "correction.ended",
            payload: { status: "cancelled" },
            createdAt: new Date().toISOString(),
          } as unknown as RunEvent);
        }
      }
    },
  };

  type Message = { text?: string; go?: true; taskId?: string; marks?: unknown[] };

  /** The API's writes for a message `id`: `run.reopened`, then the message. */
  function serverEvents(id: string, message: Message) {
    const person = `${RUN}.person`;
    const add = (type: string, eid: string, payload: unknown) =>
      stored.push({
        id: eid,
        runId: RUN,
        threadId: person,
        seq: stored.length + 1,
        type,
        payload,
        createdAt: new Date().toISOString(),
      } as unknown as RunEvent);
    add("run.reopened", `${person}:${id}:reopened`, { by: "u1" });
    add("person.message", `${person}:${id}`, message);
  }

  async function claim(reopened = false): Promise<Folded> {
    const rec = recorder(store as never, RUN, () => {}, 10, [...stored]);
    const supervised = superviseRun({
      runId: RUN,
      definition,
      plan: o.plan,
      selectedOutputs: undefined,
      notes: undefined,
      inputPrefix: "inputs/",
      workflows: [{ repo: "voluma-bio/voluma", path: "workflows/mouse-oa" }],
      recorder: rec,
      history: {
        load: async (t) => {
          const ms = o.delayLoad?.(t) ?? 0;
          if (ms > 0) await sleep(ms);
          return history.get(t) ?? [];
        },
        appendMessage: async (t, idx, m) => {
          const rows = history.get(t) ?? history.set(t, []).get(t)!;
          if (rows[idx] === undefined) rows.push(m);
        },
      },
      evidence: {
        keep: async (_run, taskId, f) => {
          if (o.evidenceExists?.(f.root, taskId, f.path) === false)
            throw new EvidenceNotFound(f.path);
          return "0".repeat(64);
        },
      },
      files: {
        read: () => {
          throw new Error("these runs read no files");
        },
        write: async () => {},
        list: async () => [],
      },
      outputs: {
        backup: async () => {},
        restore: async () => {},
        discard: async () => {},
      },
      model: (role) => ({
        model: modelOf[role].getModel(),
        thinkingLevel: "off" as const,
        streamFn: models.streamSimple.bind(models) as never,
      }),
      createSandbox: async () => {
        throw new Error("these runs call no sandbox");
      },
      sandbox: { image: "faux", lifetimeSeconds: 60, idleSeconds: 60 },
      config: o.config,
      providerError: o.providerError,
      log: () => {},
      // A reopen clears the claim-end reason (`messages.ts`).
      ...(stored.length > 0 && !reopened && { previousClaim: "shutdown" as const }),
      signal: abort.signal,
      conversionSignal: abort.signal,
    });
    try {
      return await supervised.result;
    } finally {
      await supervised.close();
    }
  }

  return {
    stored: stored as readonly RunEvent[],
    /** Whether a claim was cut off by `cutAfter`. */
    get wasCut() {
      return cut;
    },
    /** Runs claims until one is not cut off; returns the fold of the last. */
    async run(): Promise<Folded> {
      let folded = await claim();
      while (cut && !cancelled && abort.signal.aborted) {
        abort = new AbortController();
        frozen = false;
        folded = await claim();
      }
      return folded;
    },
    /**
     * What the API does when the researcher writes to the finished run (`messages.ts`): stores
     * `run.reopened` and `person.message` (server events, thread `<run>.person`), then the run is
     * claimed once more. Returns the fold of the last claim.
     */
    async send(message: Message, id = `m${++n}`): Promise<Folded> {
      cut = frozen = false; // a cancelled correction does not stop the next one
      serverEvents(id, message);
      abort = new AbortController();
      return claim(true);
    },
    /** The log as one line per event, for a failure message. */
    text(): string {
      return stored.map((e) => line(e)).join("\n");
    },
  };
}

const short = (id: string) => id.replace(`${RUN}.`, "");

function line(e: RunEvent): string {
  const who = short(e.threadId);
  switch (e.type) {
    case "task":
      return `${who} task ${e.payload.taskId} ${e.payload.status} (${e.payload.by.kind === "rule" ? e.payload.by.rule : e.payload.by.kind})`;
    case "tool.call":
      return `${who} call ${e.payload.name} ${JSON.stringify(e.payload.input).slice(0, 80)}`;
    case "tool.result":
      return `${who} result ${e.payload.isError ? "ERR " : ""}${e.payload.output.slice(0, 120)}`;
    case "thread.ended":
      return `${who} thread.ended ${e.payload.status}`;
    case "message":
      return e.payload.role === "user"
        ? `${who} user(${e.payload.sender.kind}): ${e.payload.text.slice(0, 100).replaceAll("\n", " | ")}`
        : `${who} assistant: ${e.payload.text.slice(0, 60)}`;
    default:
      return `${who} ${e.type}`;
  }
}
