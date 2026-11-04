/**
 * The agent model's coordination tools: `message`, `close`, `start_worker`, `close_worker` and
 * `change_outputs`. Each runs inside the run's section, writes its event first under an id
 * derived from the call (`effects.ts`), then wakes the loop; a repeated call finds its event and
 * answers from it. Deliveries are the loop's job (`loop.ts`), not the tools'. A refusal is a
 * plain-language tool error naming what to do instead.
 */

import {
  type AgentLog,
  type AgentRecord,
  type AgentState,
  approvalSettledId,
  givenApprovals,
  openApprovals,
  openWorkers,
} from "@voluma/contracts/agents";
import { refuseOutputsChange } from "@voluma/contracts/final-outputs";
import {
  type OutputCatalog,
  outputKindSchema,
  outputRefSchema,
} from "@voluma/contracts/output-catalog";
import { outputsFold, pendingFinal, undecidedOutOfDate } from "@voluma/contracts/output-fold";
import { z } from "zod";
import type { Section } from "../../loop-shell";
import type { Recorder } from "../../recorder";
import { threadIdOf } from "../../thread-id";
import type { Tool, ToolContext, ToolResult } from "../../tools/tool";
import { wrapUpText } from "../deliveries";
import {
  activityId,
  changeOutputsId,
  closeEventId,
  closeWorkerEndId,
  closeWorkerId,
  messageEventId,
} from "../effects";
import { Refusal } from "./refusal";

/** What the tools need of the loop: its lock, the log, and the few things only it can do. */
export interface AgentsApi {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  section: Section;
  log(): AgentLog;
  /** An agent's state, with this process's running threads overlaid. */
  state(r: AgentRecord): AgentState;
  /** The most workers open at once (X). */
  limit: number;
  /** The names of the skills a brief may ask to load. */
  skills: readonly string[];
  catalog: OutputCatalog;
  /** Appends the worker's `thread.started`, then starts it. Called inside the section. */
  startWorker(w: {
    name: string;
    brief: string;
    skills: string[];
    from?: string;
    blind?: string;
    outputs?: string[];
    spawnedBy: string;
    parentThreadId: string;
  }): Promise<void>;
  /** Renders the closed worker's stored history now; the function it returns writes `/work/<name>/transcript.md`. */
  prepareTranscript(agent: { id: string; name: string }): Promise<() => Promise<void>>;
  /** Stops a running thread (its end is stored first). */
  abort(threadId: string): void;
  /** Rewrites `/run/*.yaml`; awaited, so the caller's next call sees them. */
  refreshRunFiles(): Promise<void>;
  /** Wakes the loop. */
  changed(): void;
}

const RESERVED = ["main", "researcher", "supervisor", "person"];
const NAME = /^[a-z][a-z0-9-]*$/;

/** Types a tool's `execute` from its `input` schema, then erases the schema for the registry. */
const define = <S extends z.ZodType>(tool: Tool<S>): Tool => tool as unknown as Tool;

const text = (output: string, extra?: Partial<ToolResult>): ToolResult => ({
  output,
  isError: false,
  truncated: false,
  ...extra,
});

async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { output: error.message, isError: true, truncated: false };
  }
}

function caller(api: AgentsApi, ctx: ToolContext) {
  const { agent } = ctx;
  const d = api.log();
  if (d.rootEnded) throw new Refusal("The run has ended.");
  return { ...agent, d, from: agent.role === "main" ? "main" : agent.name };
}

const byName = (d: AgentLog, name: string) =>
  name === "main" ? d.main : [...d.records.values()].find((r) => r.name === name);

const names = (d: AgentLog) =>
  [...d.records.values()].filter((r) => r.place === "worker").map((r) => r.name);

/** The workers `name` was started from, nearest first: its `from`, that one's `from`, and so on. */
function lineage(d: AgentLog, name: string): string[] {
  const chain: string[] = [];
  for (let r = byName(d, name); r?.from && !chain.includes(r.from); r = byName(d, r.from))
    chain.push(r.from);
  return chain;
}

const messageTool = (api: AgentsApi): Tool =>
  define({
    name: "message",
    description:
      "Send a message to main, to a worker by name, or (main only) to the researcher. It reaches an idle agent as the start of its turn and a working one with its next tool result.",
    input: z.object({
      to: z.string().min(1).describe("`main`, a worker's name, or `researcher` (main only)."),
      text: z.string().min(1),
    }),
    execute: ({ to, text: body }, ctx) =>
      run(() =>
        api.section(async () => {
          const { name, role, d, from } = caller(api, ctx);
          const id = messageEventId(ctx.threadId, ctx.toolCallId);
          if (d.written.has(id)) return text(`Sent to ${to}.`);
          if (to === name || (to === "main" && role === "main"))
            throw new Refusal("You cannot message yourself.");
          if (to === "researcher") {
            if (role !== "main")
              throw new Refusal("Only main speaks to the researcher: message main.");
          } else {
            const target = byName(d, to);
            if (!target)
              throw new Refusal(`No agent is named ${to}. Agents: main, ${names(d).join(", ")}.`);
            const state = api.state(target);
            if (state === "closing" || state === "closed")
              throw new Refusal(
                `${to} is ${state} and takes no more messages; start a new worker.`,
              );
            const sender = byName(d, name);
            if (sender?.blind && to !== "main")
              throw new Refusal("You work blind: you message main only.");
            if (target.blind && role !== "main")
              throw new Refusal(`${to} works blind and takes messages from main only.`);
          }
          await api.recorder.append(ctx.threadId, "agent.message", { from, to, text: body }, id);
          api.changed();
          return text(`Sent to ${to}.`);
        }),
      ),
  });

const activityTool = (api: AgentsApi): Tool =>
  define({
    name: "activity",
    description:
      "Say in one plain sentence what you are doing now, for the researcher watching the run. It replaces your last line. Send one when your work changes and at least every few minutes while you work; no ids, file paths, counts or step numbers.",
    input: z.object({ text: z.string().min(1).max(300) }),
    execute: ({ text: line }, ctx) =>
      run(() =>
        api.section(async () => {
          caller(api, ctx);
          await api.recorder.append(
            ctx.threadId,
            "activity",
            { text: line },
            activityId(ctx.threadId, ctx.toolCallId),
          );
          return text("Noted.");
        }),
      ),
  });

/** The run is closed only when nothing is open, undecided, unanswered or pending. */
function mainCloseRefusal(api: AgentsApi, d: AgentLog): string | undefined {
  const events = api.recorder.events();
  if (givenApprovals(d.approvals).length > 0)
    return "A call the researcher approved is still running; close once it has finished.";
  const open = openWorkers(d, (id) => api.state(d.records.get(id) as AgentRecord) === "working");
  if (open.length > 0)
    return `Workers are still open: ${open.map((r) => r.name).join(", ")}. Close each with close_worker first.`;
  const stale = undecidedOutOfDate(events);
  if (stale.length > 0)
    return `These outputs are out of date and you have not decided them: ${stale.join(", ")}. Keep each with keep_output if it still holds, or have it redone.`;
  if (d.unansweredPerson.length > 0)
    return "The researcher wrote and you have not answered them: message researcher first.";
  const pending = pendingFinal(events);
  if (pending.length > 0)
    return `These final outputs have no version yet: ${pending.join(", ")}. Make them, or mark them missing with change_outputs.`;
  return undefined;
}

const closeTool = (api: AgentsApi): Tool =>
  define({
    name: "close",
    description:
      "A worker: wrap up. You write your notes (what is done, what was decided and why, what is still open, where the files are: enough for someone to continue from), repeat them as your last message and end your turn; you are not resumed. Main: end the run; refused while a worker is open, an out-of-date output is undecided, the researcher's message is unanswered or a final output has no version.",
    input: z.object({}),
    execute: (_input, ctx) =>
      run(() =>
        api.section(async () => {
          const { name, role, d } = caller(api, ctx);
          if (role === "worker") {
            const me = byName(d, name);
            if (me?.closeAt !== undefined) throw new Refusal("You are already closing.");
            await api.recorder.append(
              ctx.threadId,
              "close.requested",
              { threadId: ctx.threadId, by: "self" },
              closeEventId(ctx.threadId, ctx.toolCallId),
            );
            api.changed();
            return text(wrapUpText(name));
          }
          const id = closeEventId(ctx.threadId, ctx.toolCallId);
          if (!d.written.has(id)) {
            const why = mainCloseRefusal(api, d);
            if (why) throw new Refusal(why);
            // The researcher's buttons for what was never answered go with the run.
            for (const a of openApprovals(d.approvals))
              await api.recorder.append(
                a.threadId,
                "approval.settled",
                { toolCallId: a.toolCallId, outcome: "withdrawn", text: "The run was closed." },
                approvalSettledId(a.requestId),
              );
            await api.recorder.append(
              api.rootThreadId,
              "thread.ended",
              { status: "completed" },
              id,
            );
            api.changed();
          }
          return text("The run is closed.", { terminate: true });
        }),
      ),
  });

const startWorkerInput = z.object({
  name: z.string().min(1).describe("Lowercase letters, digits and dashes; never reused in a run."),
  brief: z.string().min(1),
  skills: z.array(z.string().min(1)).optional(),
  from: z.string().min(1).optional(),
  blind: z.string().min(1).optional(),
  outputs: z
    .array(outputRefSchema)
    .min(1)
    .optional()
    .describe(
      "The outputs the worker may report; it cannot report any other (its own <name>/... intermediates aside). Required once the researcher is reviewing the run.",
    ),
});
type StartWorkerInput = z.infer<typeof startWorkerInput>;

/**
 * The refusals of `start_worker`, in order, read from `d` inside the section. True: this very call
 * already started the worker.
 */
function startRefusals(
  api: AgentsApi,
  d: AgentLog,
  role: string,
  toolCallId: string,
  { name, skills = [], from, blind, outputs }: StartWorkerInput,
): boolean {
  if (role !== "main") throw new Refusal("Only main starts workers: message main.");
  if (![...d.messages.values()].some((m) => m.from === "main" && m.to === "researcher"))
    throw new Refusal(
      "Send your plan note to the researcher first: message `researcher` with the text of /work/main/plan.md, then start workers.",
    );
  const started = d.records.get(threadIdOf(api.runId, name));
  if (started?.spawnedBy === toolCallId) return true;
  if (!NAME.test(name) || RESERVED.includes(name))
    throw new Refusal(
      "A worker's name is lowercase letters, digits and dashes, starts with a letter, and is not main, researcher, supervisor or person.",
    );
  if (started) throw new Refusal(`The name ${name} was used in this run; pick another.`);
  const unknown = skills.find((s) => !api.skills.includes(s));
  if (unknown) throw new Refusal(`No skill is named ${unknown}. Skills: ${api.skills.join(", ")}.`);
  if (d.reviewing && !outputs)
    throw new Refusal(
      "The researcher is reviewing the run: name with outputs the outputs this worker may report.",
    );
  const known = outputsFold(api.recorder.events()).byId;
  const missing = outputs?.find((id) => !api.catalog.some((e) => e.id === id) && !known.has(id));
  if (missing) throw new Refusal(`No output is named ${missing}; see /run/outputs.yaml.`);
  const worker = (n: string) => {
    const r = byName(d, n);
    if (!r || r.place !== "worker")
      throw new Refusal(`No worker is named ${n}. Workers: ${names(d).join(", ")}.`);
    return r;
  };
  if (blind) worker(blind);
  const source = from ? worker(from) : undefined;
  if (source && api.state(source) !== "closed")
    throw new Refusal(
      `${from} is ${api.state(source)}: start from a closed worker (close_worker it first).`,
    );
  if (from && blind && (from === blind || lineage(d, from).includes(blind)))
    throw new Refusal(
      `${from} ${from === blind ? "is the worker the new one is blind to" : `was started from ${blind}`}: its folder and conversation would show the new worker what it must not see.`,
    );
  const open = openWorkers(d, (id) => api.state(d.records.get(id) as AgentRecord) === "working");
  if (open.length >= api.limit) {
    const list = open
      .map((r) => {
        const state = api.state(r);
        return state === "closing" ? `${r.name} (closing)` : r.name;
      })
      .join(", ");
    throw new Refusal(
      `${open.length} workers are open (${list}), the most allowed. Close one with close_worker first.`,
    );
  }
  return false;
}

const startWorkerTool = (api: AgentsApi): Tool =>
  define({
    name: "start_worker",
    description:
      "Start a worker: a colleague with its own sandbox and its own context that keeps what it learns. Give it a name and a brief that scopes what it owns. `skills` names extra skills to load into its first message. `from` names a closed worker to carry on from: the new worker gets its note, its folder and its conversation (`/work/<name>/transcript.md`). `blind` names a worker whose reasoning the new worker must not see: it reads only its own folder and exchanges messages with main only; its brief is your question and where the published outputs are, never what the other worker concluded. `from` cannot name the blind worker or one started from it. `outputs` limits what the worker may report to those outputs; the researcher must approve a worker started while they review.",
    input: startWorkerInput,
    changesResults: {
      preflight: (input, ctx) =>
        api.section(async () => {
          const { role, d } = caller(api, ctx);
          startRefusals(api, d, role, ctx.toolCallId, input);
        }),
      outputs: (input) => input.outputs ?? [],
      summary: (input, titleOf) =>
        `Start an AI worker to redo ${(input.outputs ?? []).map(titleOf).join(", ")}.`,
      makesStale: true,
    },
    execute: (input, ctx) =>
      run(async () => {
        const { name, brief, skills = [], from, blind, outputs } = input;
        // A closed worker's history no longer changes: render it before the lock, write it inside.
        const closed = from ? byName(api.log(), from) : undefined;
        const writeTranscript =
          closed?.place === "worker" && api.state(closed) === "closed"
            ? await api.prepareTranscript(closed)
            : undefined;
        return api.section(async () => {
          const { role, d } = caller(api, ctx);
          if (startRefusals(api, d, role, ctx.toolCallId, input)) return text(`Started ${name}.`);
          await writeTranscript?.();
          await api.startWorker({
            name,
            brief,
            skills,
            ...(from && { from }),
            ...(blind && { blind }),
            ...(outputs && { outputs }),
            spawnedBy: ctx.toolCallId,
            parentThreadId: ctx.threadId,
          });
          return text(
            `Started ${name}. It begins with your brief; its reports and messages arrive in your next delivery.`,
          );
        });
      }),
  });

const closeWorkerTool = (api: AgentsApi): Tool =>
  define({
    name: "close_worker",
    description:
      "Close a worker. It writes its notes first unless `now` is set, which stops it at once and discards what it was doing. A closed worker is never resumed; start a new one if the work continues.",
    input: z.object({
      name: z.string().min(1),
      reason: z.string().min(1),
      now: z.boolean().optional(),
    }),
    execute: ({ name, reason, now }, ctx) =>
      run(() =>
        api.section(async () => {
          const { role, d } = caller(api, ctx);
          if (role !== "main") throw new Refusal("Only main closes workers.");
          const target = byName(d, name);
          const request = closeWorkerId(ctx.threadId, ctx.toolCallId);
          if (
            d.written.has(request) ||
            d.written.has(closeWorkerEndId(ctx.threadId, ctx.toolCallId))
          )
            return text(`${name} is ${now ? "stopped" : "winding up"}.`);
          if (!target || target.place !== "worker")
            throw new Refusal(`No worker is named ${name}. Workers: ${names(d).join(", ")}.`);
          const state = api.state(target);
          if (state === "closed") throw new Refusal(`${name} is already closed.`);
          if (now) {
            // The end first: a stop that crashes before the abort still shows the worker closed.
            await api.recorder.append(
              target.id,
              "thread.ended",
              { status: "cancelled", note: reason },
              closeWorkerEndId(ctx.threadId, ctx.toolCallId),
            );
            api.abort(target.id);
            api.changed();
            return text(`${name} was stopped. Its unread messages go back to their senders.`);
          }
          if (state === "closing") throw new Refusal(`${name} is already winding up.`);
          await api.recorder.append(
            target.id,
            "close.requested",
            { threadId: target.id, by: "main" },
            request,
          );
          api.changed();
          return text(`${name} is winding up. Its note arrives in a delivery when it has closed.`);
        }),
      ),
  });

const changeOutputsInput = z
  .object({
    reason: z.string().min(1),
    add: z.array(z.looseObject({ id: outputRefSchema, kind: outputKindSchema })).optional(),
    drop: z.array(outputRefSchema).optional(),
    missing: z.array(z.object({ id: outputRefSchema, reason: z.string().min(1) })).optional(),
    sections: z
      .array(z.object({ title: z.string().min(1), outputs: z.array(outputRefSchema).min(1) }))
      .optional(),
    expect: z
      .array(z.object({ id: outputRefSchema, lines: z.array(z.string().min(1)).min(1) }))
      .optional(),
  })
  .refine((p) => Object.keys(p).some((k) => k !== "reason"), {
    message: "a change changes something",
  });

const changeOutputsTool = (api: AgentsApi): Tool => {
  /** The change as `outputs.changed` stores it, or the refusal. Read inside the section. */
  const changeOf = (role: string, input: z.infer<typeof changeOutputsInput>) => {
    if (role !== "main") throw new Refusal("Only main changes the final outputs.");
    const list = outputsFold(api.recorder.events()).list;
    const change = { by: "main" as const, ...input };
    const why = refuseOutputsChange(list, change, api.catalog);
    if (why) throw new Refusal(why);
    return change;
  };
  return define({
    name: "change_outputs",
    description:
      "Change the run's final outputs (the list in /run/final-outputs.yaml): add outputs from the workflow's catalog or your workers' own (`<worker>/<id>`), drop some, mark some missing with a reason, regroup sections, or append `expect` lines. Say why in `reason`.",
    input: changeOutputsInput,
    changesResults: {
      preflight: (input, ctx) =>
        api.section(async () => {
          changeOf(caller(api, ctx).role, input);
        }),
      outputs: () => [],
      summary: (input) => `Change which outputs the run delivers: ${input.reason}.`,
    },
    execute: (input, ctx) =>
      run(() =>
        api.section(async () => {
          const { role, d } = caller(api, ctx);
          const id = changeOutputsId(ctx.threadId, ctx.toolCallId);
          if (d.written.has(id)) return text("The final outputs are changed.");
          await api.recorder.append(ctx.threadId, "outputs.changed", changeOf(role, input), id);
          await api.refreshRunFiles();
          api.changed();
          return text("The final outputs are changed; /run/final-outputs.yaml is updated.");
        }),
      ),
  });
};

export const coordinationTools = (api: AgentsApi): Record<string, Tool> => ({
  message: messageTool(api),
  activity: activityTool(api),
  close: closeTool(api),
  start_worker: startWorkerTool(api),
  close_worker: closeWorkerTool(api),
  change_outputs: changeOutputsTool(api),
});
