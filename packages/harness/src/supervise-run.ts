/**
 * Runs one run's plan to the end: the harness's own wiring of thread pool, task runtime,
 * tools and supervisor, so a host supplies only adapters (the stored record, the sandbox,
 * evidence, a model) and what a worker or check thread says and runs on (`RoleSpec` minus
 * its tools, which the harness fixes: bash, the task tools, thread messaging). Resume and a
 * first run are the same call; the recorder is built on the stored events by the host.
 */
import type { Folded } from "@voluma/contracts/fold";
import type { RunLayout } from "./layout";
import type { MainThread } from "./main-thread";
import type { Evidence } from "./ports/evidence";
import type { History } from "./ports/history";
import type { Sandbox } from "./ports/sandbox";
import type { PayloadOf, Recorder } from "./recorder";
import { type RoleSpec, supervisor, supervisorThreadId } from "./supervisor";
import { type PlanTask, taskRuntime } from "./task-runtime";
import { threads } from "./threads";
import { bashTool } from "./tools/bash";
import { taskTools } from "./tools/task-tools";
import { threadMessageTool } from "./tools/thread-message";
import type { Tool } from "./tools/tool";

/** What a worker or check thread is told and runs on; the harness adds its tools after `tools`, the role's extras. */
export type RunRole = Omit<RoleSpec, "tools"> & { tools?: Tool[] };
export type { PlanTask };

export interface SuperviseRunOptions {
  runId: string;
  plan: readonly PlanTask[];
  /** The workflow packages the run starts from, as recorded on the root's first event. */
  workflows?: PayloadOf<"thread.started">["workflows"];
  layout: RunLayout;
  recorder: Recorder;
  history: History;
  /** The run's sandbox for a thread (`sandboxSession.get`). */
  sandbox(threadId: string): Promise<Sandbox>;
  evidence: Evidence;
  main: MainThread;
  /** `notes`: the main thread's notes in force when the thread starts. */
  worker(task: PlanTask, notes: string | undefined): RunRole;
  check(task: PlanTask, notes: string | undefined): RunRole;
  signal: AbortSignal;
}

export function superviseRun(options: SuperviseRunOptions): Promise<Folded> {
  const { runId, plan, layout, recorder, signal } = options;
  const pool = threads(
    { runId, recorder, history: options.history, sandbox: options.sandbox },
    signal,
  );
  const runtime = taskRuntime({
    recorder,
    evidence: options.evidence,
    runId,
    rootThreadId: supervisorThreadId(runId),
    plan,
    stopThread: (id) => pool.abort(id),
  });
  const task = (id: string): PlanTask => {
    const found = plan.find((t) => t.id === id);
    if (!found) throw new Error(`${id} is not a task of the plan`);
    return found;
  };
  const tools = (extra: Tool[] = []) => [
    bashTool(layout),
    ...taskTools(runtime),
    threadMessageTool((from, to, text) => sup.message(from, to, text)),
    ...extra,
  ];
  const sup = supervisor({
    runId,
    plan,
    runtime,
    recorder,
    threads: pool,
    main: options.main,
    worker: (id, notes) => {
      const role = options.worker(task(id), notes);
      return { ...role, tools: tools(role.tools) };
    },
    check: (id, notes) => {
      const role = options.check(task(id), notes);
      return { ...role, tools: tools(role.tools) };
    },
    signal,
  });
  return sup.run(options.workflows);
}
