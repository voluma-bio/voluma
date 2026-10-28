/**
 * The run's first wake of the main thread: the plan computed from the user's selected outputs
 * may be adapted to the user's notes before anything runs. With no notes there is nothing to
 * adapt and the model is not asked. The answer is stored as the `run-started` `wake` before it
 * is used, and `revision.started.plan` (written by the task runtime from what this returns)
 * stays the record of what was applied: a run that has a `revision.started` returns its plan,
 * and one that crashed between the wake and the revision returns the plan the wake recorded.
 * An answer that drops a selected output, or does not parse, is recorded as an `error` and the
 * computed plan runs.
 */
import { WAKE_ERROR_MAX } from "@voluma/contracts/events";
import type { MainThread } from "./main-thread";
import { pointOf } from "./main-thread";
import type { Recorder } from "./recorder";
import type { PlanTask } from "./task-runtime";
import { threadLog, WAKE_SUFFIX } from "./thread-log";

export interface RunStartOptions {
  runId: string;
  /** The root thread, whose events the wake is written under. */
  rootThreadId: string;
  recorder: Recorder;
  main: MainThread;
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
  const recorded = threadLog(events).wakes.get(key);
  if (recorded) return recorded.plan?.tasks ?? o.computed;
  if (!o.notes) return o.computed;

  const wanted = o.selectedOutputs ?? o.computed.flatMap((t) => t.outputs.map((out) => out.id));
  const point = {
    kind: "run-started",
    report: { selectedOutputs: o.selectedOutputs ?? "all", notes: o.notes, plan: o.computed },
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
  let reply: Awaited<ReturnType<MainThread["ask"]>> = {};
  try {
    reply = await Promise.race([o.main.ask(point, [], limit), expired]);
    const kept = new Set(reply.plan?.tasks.flatMap((t) => t.outputs.map((out) => out.id)));
    const dropped = reply.plan && wanted.filter((id) => !kept.has(id));
    if (dropped?.length)
      throw new Error(`the plan drops the selected output(s) ${dropped.join(", ")}`);
  } catch (e) {
    error = String(e);
  }
  if (o.signal?.aborted) return o.computed; // a stop is no answer; the supervisor ends the run
  await o.recorder.append(
    o.rootThreadId,
    "wake",
    {
      point: pointOf(point),
      model: o.main.model,
      ...(error !== undefined
        ? { error: error.slice(0, WAKE_ERROR_MAX) }
        : {
            ...(reply.note !== undefined && { note: reply.note }),
            ...(reply.plan && { plan: reply.plan }),
          }),
    },
    `${key}${WAKE_SUFFIX}`,
  );
  return (error === undefined && reply.plan?.tasks) || o.computed;
}
