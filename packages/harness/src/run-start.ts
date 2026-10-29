/**
 * The run's first wake of the main thread: the plan computed from the user's selection may be
 * adapted to the user's notes before anything runs. With no notes there is nothing to adapt
 * and the model is not asked. The model answers only a change (done-when lines to append,
 * workflow tasks to add); code builds the plan from the workflow files (`adaptPlan`), so
 * outputs, units, ranges and what is required can never change. The result is stored as the
 * `run-started` `wake` (with the built plan) before it is used, and `revision.started.plan`
 * (written by the task runtime from what this returns) stays the record of what was applied:
 * a run that has a `revision.started` returns its plan, and one that crashed between the wake
 * and the revision returns the plan the wake recorded. An answer that does not parse or names
 * an unknown task is recorded as an `error` and the computed plan runs.
 */
import { WAKE_ERROR_MAX } from "@voluma/contracts/events";
import type { WorkflowFiles } from "@voluma/contracts/workflow-files";
import { adaptPlan } from "@voluma/workflow/plan";
import { replyFrames } from "./live";
import type { MainThread, Reply } from "./main-thread";
import { pointOf, UnusableReplyError } from "./main-thread";
import type { Recorder } from "./recorder";
import type { PlanTask } from "./task-runtime";
import { threadLog, WAKE_SUFFIX } from "./thread-log";

export interface RunStartOptions {
  runId: string;
  /** The root thread, whose events the wake is written under. */
  rootThreadId: string;
  recorder: Recorder;
  main: MainThread;
  workflow: WorkflowFiles;
  /** The plan computed from the selection. */
  computed: readonly PlanTask[];
  /** The output ids the user selected; absent: every output. */
  selectedOutputs?: readonly string[];
  /** The user's notes for the run. */
  notes?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function runStartPlan(o: RunStartOptions): Promise<readonly PlanTask[]> {
  const events = o.recorder.events();
  const started = events.find((e) => e.type === "revision.started" && e.payload.reason === "run");
  if (started?.type === "revision.started" && started.payload.reason === "run") {
    return started.payload.plan.tasks;
  }
  const key = `${o.runId}.run-started@1`;
  const wakeId = `${key}${WAKE_SUFFIX}`;
  const recorded = threadLog(events).wakes.get(key);
  if (recorded) return recorded.plan?.tasks ?? o.computed;
  if (!o.notes) return o.computed;

  const inPlan = new Set(o.computed.map((t) => t.id));
  const point = {
    kind: "run-started",
    report: {
      userNotes: o.notes,
      addableTasks: o.workflow.tasks
        .filter((t) => !inPlan.has(t.id))
        .map((t) => ({ id: t.id, dependsOn: t.dependsOn, outputs: t.outputs })),
    },
  } as const;
  const limit = AbortSignal.any([
    AbortSignal.timeout(o.timeoutMs),
    ...(o.signal ? [o.signal] : []),
  ]);
  const expired = new Promise<never>((_, reject) =>
    limit.addEventListener("abort", () => reject(new Error("timed out or cancelled")), {
      once: true,
    }),
  );
  let error: string | undefined;
  let note: string | undefined;
  let usage: Reply["usage"];
  let plan: ReturnType<typeof adaptPlan> | undefined;
  try {
    const reply = await Promise.race([
      o.main.ask(point, [], limit, replyFrames(o.rootThreadId, wakeId, o.recorder.live)),
      expired,
    ]);
    usage = reply.usage;
    note = reply.note;
    if (reply.change) plan = adaptPlan(o.workflow, o.selectedOutputs, reply.change);
  } catch (e) {
    error = String(e);
    if (e instanceof UnusableReplyError) usage = e.usage;
  }
  if (o.signal?.aborted) return o.computed; // a stop is no answer; the supervisor ends the run
  await o.recorder.append(
    o.rootThreadId,
    "wake",
    {
      point: pointOf(point),
      model: o.main.model,
      ...(error !== undefined
        ? { error: error.slice(0, WAKE_ERROR_MAX), ...(usage && { usage }) }
        : {
            ...(usage && { usage }),
            ...(note !== undefined && { note }),
            ...(plan && { plan }),
          }),
    },
    wakeId,
  );
  return plan?.tasks ?? o.computed;
}
