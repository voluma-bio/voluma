/**
 * The task loop's half of `superviseRun`'s wiring: which of the workflow's facts shape the
 * layout (roles' tools, tasks that copy inputs) and how the loop's parts are assembled (backup
 * of `/outputs`, the task runtime, the run loop with its tools). The shell around it is shared
 * by every loop (`supervise-run.ts`).
 */
import type { WorkflowDefinition } from "@voluma/workflow/definition";
import type { BashRuntime } from "./bash-runtime";
import { type RunLayout, type RunLayoutOptions, runLayout, type ThreadLayout } from "./layout";
import type { Section } from "./loop-shell";
import { keepOutputs } from "./outputs-backup";
import type { Evidence } from "./ports/evidence";
import type { Files } from "./ports/files";
import type { Outputs } from "./ports/outputs";
import type { Recorder } from "./recorder";
import { type LoopConfig, type ModelSetup, type ProviderError, runLoop } from "./run-loop";
import type { SandboxSession } from "./sandbox-session";
import { type PlanTask, taskRuntime } from "./task-runtime";
import { threadLog } from "./thread-log";
import type { Threads } from "./threads";
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

export interface TasksWireOptions {
  runId: string;
  inputId: string;
  inputPrefix: string;
  recorder: Recorder;
  definition: WorkflowDefinition;
  /** Whether a gateway is configured (`segment_sam` is held only where it can be used). */
  gateway: boolean;
}

/**
 * The task loop's half of the run: its layout (sandbox of each thread, from the thread's record)
 * and `run`, which assembles the task runtime and the loop on the shared shell's pool and lock.
 */
export function tasksWire(o: TasksWireOptions) {
  const { recorder, definition } = o;
  const copyInputs = new Set(definition.files.tasks.filter((t) => t.copyInputs).map((t) => t.id));
  const layout = runLayout({
    runId: o.runId,
    inputId: o.inputId,
    inputPrefix: o.inputPrefix,
    skills: definition.skills,
    roles: rolesOf(definition, o.gateway),
    // From the workflow's task, so a task the main agent adds from it keeps the flag.
    copiesInputs: (id) => copyInputs.has(id),
  });
  const recordOf = (threadId: string) => {
    const record = threadLog(recorder.events()).threads.get(threadId);
    if (!record) throw new Error(`${threadId} has no thread.started`);
    return record;
  };
  return {
    /** The review-asset converter's sandbox. */
    convert: layout.convert,
    /** A thread's sandbox; its `thread.started` is stored before its first sandbox call. */
    sandboxOf: (threadId: string): ThreadLayout => layout.forThread(recordOf(threadId)),
    nameOf: (threadId: string) => recordOf(threadId).name,
    /** A task thread releases its sandbox at each end. */
    keepsSandbox: () => false,
    run: (r: TasksRun) => runTasks({ ...r, definition }, layout),
  };
}

export type TasksWire = ReturnType<typeof tasksWire>;

/** What the shell hands the task loop, and the host's settings it passes through. */
export interface TasksRun {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  plan: readonly PlanTask[];
  selectedOutputs: readonly string[] | undefined;
  notes: string | undefined;
  model(role: string, recorded: string | undefined): ModelSetup;
  config?: Partial<LoopConfig>;
  providerError?(error: string): ProviderError | undefined;
  files: Files;
  evidence: Evidence;
  outputs: Outputs;
  session: SandboxSession;
  bash: BashRuntime;
  pool: Threads;
  section: Section;
  signal: AbortSignal;
}

async function runTasks(
  o: TasksRun & { definition: WorkflowDefinition },
  layout: RunLayout,
): Promise<void> {
  const { runId, rootThreadId, recorder, definition, session, pool, signal } = o;
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
  const runtime = taskRuntime({
    recorder,
    section: o.section,
    evidence: o.evidence,
    runId,
    layoutOf: layout.forThread,
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
    section: o.section,
    threads: pool,
    layout,
    definition,
    selectedOutputs: o.selectedOutputs,
    notes: o.notes,
    model: o.model,
    config: o.config,
    tools: (thread, agents) =>
      buildTools(thread.tools, {
        layout: thread,
        bash: o.bash,
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
