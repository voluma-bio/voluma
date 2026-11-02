/**
 * The agent loop's half of `superviseRun`'s wiring: each agent's layout (its own `/work` folder
 * and the read-only shared mounts), the tools its role holds, its prompts and model, and the
 * loop on the shared shell's pool and lock. Task-loop wiring is `tasks-wire.ts`.
 */
import { agentLog } from "@voluma/contracts/agents";
import type { WorkflowDefinition } from "@voluma/workflow/definition";
import type { ThreadLayout } from "../layout";
import { runLayout } from "../layout";
import type { Section } from "../loop-shell";
import type { Files } from "../ports/files";
import type { Publish } from "../ports/publish";
import type { Recorder } from "../recorder";
import type { ModelSetup, ProviderError } from "../run-loop";
import type { SandboxSession } from "../sandbox-session";
import type { Threads } from "../threads";
import { type AgentLoopConfig, agentLoop, interruptedResult } from "./loop";
import { firstMessageOf, systemPromptOf } from "./prompts";
import { runFiles } from "./run-files";
import { sandboxHash } from "./sandbox-hash";
import { buildAgentTools } from "./tools/registry";

export interface AgentsWireOptions {
  runId: string;
  inputId: string;
  inputPrefix: string;
  recorder: Recorder;
  definition: WorkflowDefinition;
  /** Whether a gateway is configured (`segment_sam` is held only where it can be used). */
  gateway: boolean;
}

export function agentsWire(o: AgentsWireOptions) {
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
  const forAgent = (name: string, role: "main" | "worker"): ThreadLayout =>
    layout.forAgent({ name, role, tools: roles[role]?.tools ?? [] });
  return {
    convert: layout.convert,
    sandboxOf: (threadId: string): ThreadLayout => {
      const r = recordOf(threadId);
      return forAgent(r.name, r.place);
    },
    nameOf: (threadId: string) => recordOf(threadId).name,
    run: (r: AgentsRun) => runAgents(r, forAgent),
  };
}

export type AgentsWire = ReturnType<typeof agentsWire>;

/** What the shell hands the agent loop, and the host's settings it passes through. */
export interface AgentsRun {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  definition: WorkflowDefinition;
  selectedOutputs: readonly string[] | undefined;
  notes: string | undefined;
  model(role: string, recorded: string | undefined): ModelSetup;
  config?: Partial<AgentLoopConfig>;
  providerError?(error: string): ProviderError | undefined;
  files: Files;
  publish: Publish;
  session: SandboxSession;
  pool: Threads;
  section: Section;
  signal: AbortSignal;
}

async function runAgents(
  o: AgentsRun,
  forAgent: (name: string, role: "main" | "worker") => ThreadLayout,
): Promise<void> {
  const { definition, recorder } = o;
  const catalog = definition.outputCatalog;
  if (!catalog)
    throw new Error("this workflow has no outputs.yaml, so the agent loop cannot run it");
  const files = runFiles({ runId: o.runId, recorder, files: o.files, signal: o.signal });
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
    providerError: o.providerError,
    config: o.config,
    signal: o.signal,
    setup(agent, api) {
      const layout = forAgent(agent.name, agent.role);
      const recorded = api.log().records.get(agent.id)?.model;
      const setup = o.model(agent.role, recorded);
      const prompt = { ...agent, layout };
      return {
        ...setup,
        systemPrompt: systemPromptOf(definition, prompt),
        prompt: firstMessageOf(definition, prompt, recorder.events(), o.notes),
        tools: buildAgentTools(layout.tools, {
          layout,
          files: o.files,
          api,
          outputs: {
            runId: o.runId,
            recorder,
            publish: o.publish,
            catalog,
            layoutOf: (threadId) => {
              const r = api.log().records.get(threadId);
              if (!r) throw new Error(`${threadId} has no thread.started`);
              return forAgent(r.name, r.place);
            },
            hashIn: async (threadId, path, signal) =>
              sandboxHash(await o.session.get(threadId, { note: false }), path, signal),
            section: o.section,
            changed: api.changed,
            refreshRunFiles: files.refresh,
          },
        }),
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
