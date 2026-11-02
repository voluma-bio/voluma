/**
 * The task loop's half of `superviseRun`'s wiring: which of the workflow's facts shape the
 * layout (roles' tools, tasks that copy inputs) and how the loop's parts are assembled (backup
 * of `/outputs`, the task runtime, the run loop with its tools). The shell around it is shared
 * by every loop (`supervise-run.ts`).
 */
import type { WorkflowDefinition } from "@voluma/workflow/definition";
import { withImageRefs } from "./adapters/pi/image-refs";
import type { RunLayout, RunLayoutOptions } from "./layout";
import { keepOutputs } from "./outputs-backup";
import type { Evidence } from "./ports/evidence";
import type { Files } from "./ports/files";
import type { History } from "./ports/history";
import type { Outputs } from "./ports/outputs";
import type { Recorder } from "./recorder";
import { type LoopConfig, type ModelSetup, type ProviderError, runLoop } from "./run-loop";
import type { SandboxSession } from "./sandbox-session";
import { type PlanTask, taskRuntime } from "./task-runtime";
import { threads } from "./threads";
import { buildTools } from "./tools/registry";

/**
 * Each role's layout facts and the tools it holds: its file's list, less `segment_sam` where it
 * cannot be used. That needs the gateway and a sandbox that produces results: one with `/outputs`
 * writable. A role that only inspects (its `/outputs` is read-only) never holds it: it does not
 * redo the task.
 */
function rolesOf(def: WorkflowDefinition, gateway: boolean): RunLayoutOptions["roles"] {
  return Object.fromEntries(
    Object.values(def.agents).map(({ name, tools, scratch, outputs, checkedBy, subagents }) => {
      const analyses = tools.includes("bash") && outputs === "write";
      const held = tools.filter((t) => t !== "segment_sam" || (gateway && analyses));
      return [name, { scratch, outputs, checkedBy, subagents, tools: held }];
    }),
  );
}

/** The workflow-dependent options of the run's layout. */
export function tasksLayoutOptions(
  definition: WorkflowDefinition,
  gateway: boolean,
): Pick<RunLayoutOptions, "roles" | "copiesInputs"> {
  const copyInputs = new Set(definition.files.tasks.filter((t) => t.copyInputs).map((t) => t.id));
  return {
    roles: rolesOf(definition, gateway),
    // From the workflow's task, so a task the main agent adds from it keeps the flag.
    copiesInputs: (id) => copyInputs.has(id),
  };
}

export interface TasksLoopOptions {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  definition: WorkflowDefinition;
  plan: readonly PlanTask[];
  layout: RunLayout;
  selectedOutputs: readonly string[] | undefined;
  notes: string | undefined;
  model(role: string, recorded: string | undefined): ModelSetup;
  config?: Partial<LoopConfig>;
  providerError?(error: string): ProviderError | undefined;
  history: History;
  evidence: Evidence;
  files: Files;
  outputs: Outputs;
  session: SandboxSession;
  /** A thread's name, from its `thread.started`. */
  nameOf(id: string): string;
  log(line: string): void;
  signal: AbortSignal;
}

/** Runs the task loop to the end of the run. */
export async function runTasksLoop(o: TasksLoopOptions): Promise<void> {
  const { runId, rootThreadId, recorder, definition, session, signal } = o;
  const main = definition.agents.main;
  // Before any thread or sandbox: nothing may write or read `/outputs` while it is put back.
  await keepOutputs({
    runId,
    rootThreadId,
    recorder,
    outputs: o.outputs,
    mainWorks: main.tools.includes("bash") && main.outputs === "write",
    signal,
  });
  const pool = threads(
    {
      recorder,
      history: withImageRefs(o.history, o.files, runId, o.nameOf),
      sandbox: (id) => session.get(id),
      release: (id) =>
        session.release(id).catch((e) => o.log(`releasing ${o.nameOf(id)} failed: ${e}`)),
    },
    signal,
  );
  const runtime = taskRuntime({
    recorder,
    evidence: o.evidence,
    runId,
    layoutOf: o.layout.forThread,
    sandbox: (id, opts) => session.get(id, opts),
    rootThreadId,
    plan: o.plan,
    abortThread: (id) => {
      if (pool.started(id)) pool.abort(id);
    },
  });
  await runLoop({
    runId,
    rootThreadId,
    recorder,
    runtime,
    threads: pool,
    layout: o.layout,
    definition,
    selectedOutputs: o.selectedOutputs,
    notes: o.notes,
    model: o.model,
    config: o.config,
    tools: (thread, agents) =>
      buildTools(thread.tools, {
        layout: thread,
        files: o.files,
        runtime,
        main: {
          rootThreadId,
          recorder,
          runtime,
          agents,
          subagents: thread.subagents,
          workflow: definition.files,
        },
      }),
    providerError: o.providerError,
    signal,
  });
}
