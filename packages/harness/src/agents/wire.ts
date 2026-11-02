/**
 * The agent loop's half of `superviseRun`'s wiring: each agent's layout (its own `/work` folder
 * and the read-only shared mounts), the tools its role holds, its prompts and model, and the
 * loop on the shared shell's pool and lock. Task-loop wiring is `tasks-wire.ts`.
 */
import { agentLog } from "@voluma/contracts/agents";
import { renderFinalOutputs } from "@voluma/contracts/output-files";
import type { AgentsDefinition } from "@voluma/workflow/definition";
import type { BashRuntime } from "../bash-runtime";
import type { ThreadLayout } from "../layout";
import { runLayout } from "../layout";
import type { Shared, Wire } from "../loop-shell";
import type { Recorder } from "../recorder";
import { keepNotes } from "./keep-notes";
import { type AgentLoopConfig, agentLoop, interruptedResult, openingOutputs } from "./loop";
import { type AgentStart, firstMessageOf, systemPromptOf } from "./prompts";
import { runFiles } from "./run-files";
import { sandboxHash } from "./sandbox-hash";
import { buildAgentTools } from "./tools/registry";

export interface AgentsWireOptions {
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
  const forAgent = (name: string, role: "main" | "worker"): ThreadLayout =>
    layout.forAgent({
      name,
      role,
      tools: roles[role]?.tools ?? [],
      // A sandbox mounts the folders of the agents that exist when it is created; a new one is seen after the idle timeout.
      peers: [...agentLog(recorder.events()).records.values()].map((r) => r.name),
    });
  return {
    sandboxOf: (threadId: string): ThreadLayout => {
      const r = recordOf(threadId);
      return forAgent(r.name, r.place);
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

export type AgentsWire = ReturnType<typeof agentsWire>;

async function runAgents(
  o: Shared,
  definition: AgentsDefinition,
  forAgent: (name: string, role: "main" | "worker") => ThreadLayout,
): Promise<void> {
  const { recorder } = o;
  const catalog = definition.outputCatalog;
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
    bash: o.bash,
    release: o.release,
    keepNotes: (agent) => keepNotes(o.publish, o.runId, agent, o.signal),
    providerError: o.providerError,
    config: o.config,
    signal: o.signal,
    setup(agent, api) {
      const layout = forAgent(agent.name, agent.role);
      const recorded = api.log().records.get(agent.id)?.model;
      const setup = o.model(agent.role, recorded);
      const start: AgentStart =
        agent.role === "main"
          ? {
              role: "main",
              finalOutputs: renderFinalOutputs(recorder.events()),
              selected: openingOutputs(catalog, o.selectedOutputs).length,
              limit: api.limit,
              ...(o.notes && { notes: o.notes }),
            }
          : {
              role: "worker",
              name: agent.name,
              brief: agent.brief ?? "",
              ...(agent.skills && { skills: agent.skills }),
            };
      return {
        ...setup,
        systemPrompt: systemPromptOf({ definition, layout }),
        prompt: firstMessageOf({ definition, start }),
        tools: buildAgentTools(layout.tools, {
          layout,
          files: o.files,
          api,
          bash: o.bash,
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
