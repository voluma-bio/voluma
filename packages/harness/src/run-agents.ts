/**
 * The agent loop on a run's parts: each agent's layout (its own `/work` folder and the read-only
 * shared mounts), the tools its role holds, its prompts and model. `agentLayouts` is what the
 * sandbox session needs before the loop runs; `runAgents` is the loop itself.
 */
import { type AgentLog, agentLog } from "@voluma/contracts/agents";
import { openingOutputs } from "@voluma/contracts/final-outputs";
import { renderFinalOutputs } from "@voluma/contracts/output-files";
import type { WorkflowDefinition } from "@voluma/workflow/definition";
import { summarizeRows } from "./adapters/pi/compaction";
import type { BashRuntime } from "./bash-runtime";
import type { ProviderError } from "./failure-policy";
import { keepNotes, restoreMainPlan } from "./keep-notes";
import type { ThreadLayout } from "./layout";
import { GATEWAY_TOOLS, runLayout } from "./layout";
import { agentLoop, interruptedResult } from "./loop";
import type { LoopConfig, ModelSetup } from "./loop-config";
import type { Section } from "./loop-shell";
import { usageOf } from "./model-usage";
import { FileNotFound, type RunBucket } from "./ports/bucket";
import type { History } from "./ports/history";
import {
  type AgentStart,
  firstMessageOf,
  HANDOVER_INSTRUCTION,
  skillBlock,
  systemPromptOf,
} from "./prompts";
import type { Recorder } from "./recorder";
import { runFiles } from "./run-files";
import { sandboxHash } from "./sandbox-hash";
import type { SandboxSession } from "./sandbox-session";
import type { Threads } from "./threads";
import type { AgentsApi } from "./tools/coordination";
import { leaveToResearcher } from "./tools/keep-output";
import type { OutputToolDeps } from "./tools/output-shared";
import { approvedTool, buildAgentTools } from "./tools/registry";
import { prepareTranscript } from "./transcript";

interface AgentLayoutsOptions {
  runId: string;
  inputPrefix: string;
  recorder: Recorder;
  definition: WorkflowDefinition;
  /** Whether a gateway is configured (the gateway tools are held only where they can be used). */
  gateway: boolean;
}

export function agentLayouts(o: AgentLayoutsOptions) {
  const { recorder, definition } = o;
  /** Each role's tools: its file's list, less the gateway tools where no gateway is configured. */
  const toolsOf = (role: "main" | "worker") =>
    definition.agents[role].tools.filter((t) => !GATEWAY_TOOLS.includes(t) || o.gateway);
  const layout = runLayout({
    runId: o.runId,
    inputPrefix: o.inputPrefix,
    skills: definition.skills,
  });
  const recordOf = (threadId: string) => {
    const record = agentLog(recorder.events()).records.get(threadId);
    if (!record) throw new Error(`${threadId} has no thread.started`);
    return record;
  };
  const forAgent = (
    name: string,
    role: "main" | "worker",
    blind: boolean,
    from?: string,
  ): ThreadLayout =>
    layout.forAgent({
      name,
      role,
      blind,
      ...(from && { from }),
      tools: toolsOf(role),
      // A sandbox mounts the folders of the agents that exist when it is created; a new one is seen after the idle timeout.
      peers: [...agentLog(recorder.events()).records.values()].map((r) => r.name),
    });
  return {
    forAgent,
    /** A thread's sandbox; its `thread.started` is stored before its first sandbox call. */
    sandboxOf: (threadId: string): ThreadLayout => {
      const r = recordOf(threadId);
      return forAgent(r.name, r.place, r.blind !== undefined, r.from);
    },
    nameOf: (threadId: string) => recordOf(threadId).name,
    /** An agent keeps its sandbox between turns; only one that has ended gives it up. */
    keepsSandbox: (threadId: string) => {
      const end = agentLog(recorder.events()).records.get(threadId)?.end?.status;
      return end !== "closed" && end !== "cancelled";
    },
  };
}

/** The closed worker a new one starts from, and the note it closed with. */
const startedFrom = (d: AgentLog, name: string) => ({
  name,
  note: [...d.records.values()].find((r) => r.name === name)?.end?.note ?? "",
});

export interface RunAgentsOptions {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  definition: WorkflowDefinition;
  forAgent: ReturnType<typeof agentLayouts>["forAgent"];
  /** The model, thinking level and call function of a thread of `role` (`recorded`: the model a resumed thread started on). */
  model(role: "main" | "worker", recorded: string | undefined): ModelSetup;
  selectedOutputs: readonly string[] | undefined;
  notes: string | undefined;
  config?: Partial<LoopConfig>;
  providerError?(error: string): ProviderError | undefined;
  bucket: RunBucket;
  /** The agents' stored conversations (`transcript.ts` renders one). */
  history: History;
  session: SandboxSession;
  pool: Threads;
  /** The claim's background commands (`bash-runtime.ts`). */
  bash: BashRuntime;
  /** Stops a thread's background commands and releases its sandbox (called for an agent that has really ended). */
  release(threadId: string): Promise<void>;
  /** The run's one lock. */
  section: Section;
  signal: AbortSignal;
}

export async function runAgents(o: RunAgentsOptions): Promise<void> {
  const { recorder, definition, forAgent } = o;
  const catalog = definition.outputCatalog;
  const files = runFiles({ runId: o.runId, recorder, bucket: o.bucket, signal: o.signal });
  /** `sandboxThread`: the thread whose sandbox hashes a file (an approved call runs in the live main's, whoever made it). */
  const outputDeps = (api: AgentsApi, sandboxThread?: string): OutputToolDeps => ({
    runId: o.runId,
    recorder,
    bucket: o.bucket,
    catalog,
    layoutOf: (threadId) => {
      const r = api.log().records.get(threadId);
      if (!r) throw new Error(`${threadId} has no thread.started`);
      return forAgent(r.name, r.place, r.blind !== undefined, r.from);
    },
    hashIn: async (threadId, path, signal) =>
      sandboxHash(await o.session.get(sandboxThread ?? threadId, { note: false }), path, signal),
    section: o.section,
    changed: api.changed,
    refreshRunFiles: files.refresh,
  });
  await agentLoop({
    runId: o.runId,
    rootThreadId: o.rootThreadId,
    recorder,
    threads: o.pool,
    section: o.section,
    catalog,
    selectedOutputs: o.selectedOutputs,
    skills: definition.skills.map((s) => s.name),
    runFiles: files,
    bash: o.bash,
    release: o.release,
    restoreMainPlan: () => restoreMainPlan(o.bucket, o.runId, o.signal),
    keepNotes: (agent) => keepNotes(o.bucket, o.runId, agent, o.signal),
    prepareTranscript: (agent) =>
      prepareTranscript({
        history: o.history,
        bucket: o.bucket,
        runId: o.runId,
        agent,
        signal: o.signal,
      }),
    handoverSummary: async (previous, forThread) => {
      const rows = await o.history.load(previous.id);
      if (rows.length === 0) throw new Error("it stored no history");
      const { model, thinkingLevel, streamFn } = o.model("main", undefined);
      const { text, reply } = await summarizeRows(
        { threadId: previous.id, model, thinkingLevel, streamFn },
        rows,
        HANDOVER_INSTRUCTION,
        o.signal,
      );
      // The call is spend, like a compaction's: recorded on the thread it summarized.
      const used = usageOf(reply);
      await recorder.append(
        previous.id,
        "message",
        { role: "assistant", text, compaction: true, ...(used && { usage: used }) },
        `${previous.id}:handover:${forThread}`,
      );
      if (!text)
        throw new Error(
          reply.errorMessage ?? `the model wrote no summary (stop reason ${reply.stopReason})`,
        );
      return text;
    },
    providerError: o.providerError,
    config: o.config,
    signal: o.signal,
    skillBlock: (name) => {
      const skill = definition.skills.find((s) => s.name === name);
      return skill && skillBlock(skill);
    },
    stageScreenshot: async (snapshotKey) => {
      const main = forAgent("main", "main", false);
      const file = `person/${snapshotKey.split("/").pop()}`;
      try {
        await o.bucket.copy(snapshotKey, `${main.own.prefix}${file}`, { signal: o.signal });
      } catch (error) {
        if (error instanceof FileNotFound) return undefined;
        throw error;
      }
      return `${main.dir}/${file}`;
    },
    leave: (api, threadId, eventId, outputId, labels) =>
      leaveToResearcher(
        outputDeps(api),
        threadId,
        eventId,
        outputId,
        labels.map((id) => catalog.find((e) => e.id === id)?.name ?? id),
      ),
    async approved(call, api) {
      const record = api.log().records.get(call.threadId);
      if (!record) throw new Error(`${call.threadId} has no thread.started`);
      const layout = forAgent(record.name, record.place, record.blind !== undefined, record.from);
      // Main's folder is the same whichever main made the call, and a replaced one's sandbox is gone:
      // the job uses the live main's, so no sandbox is made for a thread that ended.
      const sandboxThread = api.log().main?.id ?? call.threadId;
      const tool = approvedTool(
        call.tool,
        { layout, bucket: o.bucket, api, bash: o.bash, outputs: outputDeps(api, sandboxThread) },
        call.fileHashes,
      );
      return tool.execute(tool.input.parse(call.args), {
        threadId: call.threadId,
        agent: { name: record.name, role: "main" },
        toolCallId: call.toolCallId,
        batch: [],
        signal: o.signal,
        sandbox: () => o.session.get(sandboxThread),
      });
    },
    setup(agent, api) {
      const layout = forAgent(agent.name, agent.role, agent.blind !== undefined, agent.from);
      const recorded = api.log().records.get(agent.id)?.model;
      const setup = o.model(agent.role, recorded);
      const start: AgentStart =
        agent.role === "main"
          ? {
              role: "main",
              finalOutputs: renderFinalOutputs(recorder.events()),
              selected: openingOutputs(catalog, o.selectedOutputs).length,
              limit: api.limit,
              ...(agent.handover && { handover: agent.handover }),
              ...(o.notes && { notes: o.notes }),
            }
          : {
              role: "worker",
              name: agent.name,
              brief: agent.brief ?? "",
              ...(agent.blind && { blind: true }),
              ...(agent.from && { from: startedFrom(api.log(), agent.from) }),
              ...(agent.skills && { skills: agent.skills }),
              ...(agent.outputs && { outputs: agent.outputs }),
            };
      const tools = buildAgentTools(layout.tools, {
        layout,
        bucket: o.bucket,
        api,
        bash: o.bash,
        outputs: outputDeps(api),
      });
      return {
        ...setup,
        systemPrompt: systemPromptOf({ definition, layout, review: agent.review }),
        prompt: firstMessageOf({ definition, start }),
        tools,
        labelOf: (sender) => {
          if (sender.kind === "person") return "the researcher";
          if (sender.kind === "runtime") return "Voluma";
          return api.log().records.get(sender.threadId)?.place === "main"
            ? "main"
            : (api.log().records.get(sender.threadId)?.name ?? "an agent");
        },
        interrupted: (tool, toolCallId) => interruptedResult(api.log(), agent.id, tool, toolCallId),
      };
    },
  });
}
