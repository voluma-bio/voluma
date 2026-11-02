/**
 * The agent loop's half of `superviseRun`'s wiring: each agent's layout (its own `/work` folder
 * and the read-only shared mounts), the tools its role holds, its prompts and model, and the
 * loop on the shared shell's pool and lock. Task-loop wiring is `tasks-wire.ts`.
 */
import { type AgentLog, agentLog } from "@voluma/contracts/agents";
import { renderFinalOutputs } from "@voluma/contracts/output-files";
import type { AgentsDefinition } from "@voluma/workflow/definition";
import type { ThreadLayout } from "../layout";
import { runLayout } from "../layout";
import type { Shared, Wire } from "../loop-shell";
import { EvidenceNotFound } from "../ports/evidence";
import type { Recorder } from "../recorder";
import { keepNotes } from "./keep-notes";
import { agentLoop, interruptedResult, openingOutputs } from "./loop";
import { type AgentStart, firstMessageOf, skillBlock, systemPromptOf } from "./prompts";
import { runFiles } from "./run-files";
import { sandboxHash } from "./sandbox-hash";
import type { AgentsApi } from "./tools/coordination";
import { leaveToResearcher } from "./tools/keep-output";
import type { OutputToolDeps } from "./tools/output-shared";
import { approvedTool, buildAgentTools } from "./tools/registry";
import { prepareTranscript } from "./transcript";

interface AgentsWireOptions {
  runId: string;
  inputId: string;
  inputPrefix: string;
  recorder: Recorder;
  definition: AgentsDefinition;
  /** Whether a gateway is configured (`segment_sam` is held only where it can be used). */
  gateway: boolean;
}

export function agentsWire(o: AgentsWireOptions): Wire {
  const { recorder, definition } = o;
  const roles = Object.fromEntries(
    Object.values(definition.agents).map(
      ({ name, tools, scratch, outputs, checkedBy, subagents }) => [
        name,
        {
          scratch,
          outputs,
          checkedBy,
          subagents,
          tools: tools.filter((t) => t !== "segment_sam" || o.gateway),
        },
      ],
    ),
  );
  const layout = runLayout({
    runId: o.runId,
    inputId: o.inputId,
    inputPrefix: o.inputPrefix,
    skills: definition.skills,
    roles,
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
      tools: roles[role]?.tools ?? [],
      // A sandbox mounts the folders of the agents that exist when it is created; a new one is seen after the idle timeout.
      peers: [...agentLog(recorder.events()).records.values()].map((r) => r.name),
    });
  return {
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
    run: (shared) => runAgents(shared, definition, forAgent),
  };
}

/** The closed worker a new one starts from, and the note it closed with. */
const startedFrom = (d: AgentLog, name: string) => ({
  name,
  note: [...d.records.values()].find((r) => r.name === name)?.end?.note ?? "",
});

async function runAgents(
  o: Shared,
  definition: AgentsDefinition,
  forAgent: (name: string, role: "main" | "worker", blind: boolean, from?: string) => ThreadLayout,
): Promise<void> {
  const { recorder } = o;
  const catalog = definition.outputCatalog;
  const files = runFiles({ runId: o.runId, recorder, files: o.files, signal: o.signal });
  /** `sandboxThread`: the thread whose sandbox hashes a file (an approved call runs in the live main's, whoever made it). */
  const outputDeps = (api: AgentsApi, sandboxThread?: string): OutputToolDeps => ({
    runId: o.runId,
    recorder,
    publish: o.publish,
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
    keepNotes: (agent) => keepNotes(o.publish, o.runId, agent, o.signal),
    prepareTranscript: (agent) =>
      prepareTranscript({
        history: o.history,
        files: o.files,
        runId: o.runId,
        agent,
        signal: o.signal,
      }),
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
        await o.publish.copy(snapshotKey, `${main.scratch.prefix}${file}`, { signal: o.signal });
      } catch (error) {
        if (error instanceof EvidenceNotFound) return undefined;
        throw error;
      }
      return `${main.dir}/${file}`;
    },
    leave: (api, threadId, eventId, outputId, ended) =>
      leaveToResearcher(outputDeps(api), threadId, eventId, outputId, {
        by: ended.by,
        labels: ended.labels.map((id) => catalog.find((e) => e.id === id)?.name ?? id),
      }),
    async approved(call, api) {
      const record = api.log().records.get(call.threadId);
      if (!record) throw new Error(`${call.threadId} has no thread.started`);
      const layout = forAgent(record.name, record.place, record.blind !== undefined, record.from);
      // Main's folder is the same whichever main made the call, and a replaced one's sandbox is gone:
      // the job uses the live main's, so no sandbox is made for a thread that ended.
      const sandboxThread = api.log().main?.id ?? call.threadId;
      const tool = approvedTool(
        call.tool,
        { layout, files: o.files, api, bash: o.bash, outputs: outputDeps(api, sandboxThread) },
        call.fileHashes,
      );
      return tool.execute(tool.input.parse(call.args), {
        threadId: call.threadId,
        kind: "main",
        agent: { name: record.name, role: "main" },
        toolCallId: call.toolCallId,
        batch: [],
        signal: o.signal,
        sandbox: () => o.session.get(sandboxThread),
        output: () => {},
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
              ...(agent.takeover !== undefined && { takeover: agent.takeover }),
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
        files: o.files,
        api,
        bash: o.bash,
        outputs: outputDeps(api),
      });
      return {
        ...setup,
        systemPrompt: systemPromptOf({ definition, layout }),
        prompt: firstMessageOf({ definition, start }),
        tools,
        labelOf: (sender) => {
          if (sender.kind === "person") return "the researcher";
          if (sender.kind === "runtime") return "Voluma";
          return api.log().records.get(sender.threadId)?.role === "main"
            ? "main"
            : (api.log().records.get(sender.threadId)?.name ?? "an agent");
        },
        interrupted: (tool, toolCallId) => interruptedResult(api.log(), agent.id, tool, toolCallId),
      };
    },
  });
}
