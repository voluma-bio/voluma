/**
 * The run's progress, readable without opening any agent: one row per task in plan order with
 * its state, its cost and time, and once it ends a line on how it ended (a working task shows its
 * clock instead); under them, each value reported so far, and a required one a task ended without.
 * A task's name opens its newest thread. Data: `TaskRow` and `OutputRow` from `runView`.
 */
import { catalog } from "@voluma/workflow/bundled";
import { Elapsed } from "./agents";
import { InfoButton } from "./chat/info-button";
import { useOpenThread } from "./chat/thread-navigation";
import type { OutputRow, TaskRow, TaskState } from "./run-model";
import { costLabel, spendRows } from "./spend";
import { formatDuration, formatUsd } from "./status";

const { taskTitle } = catalog["mouse-oa"];

const STATE: Record<TaskState, { label: string; dot: string; text?: string }> = {
  running: { label: "Working", dot: "bg-info motion-safe:animate-pulse" },
  checking: { label: "Being checked", dot: "bg-info motion-safe:animate-pulse" },
  done: { label: "Done", dot: "bg-primary" },
  "to-check": { label: "To check", dot: "bg-check-solid", text: "text-check-strong" },
  failed: { label: "Failed", dot: "bg-destructive", text: "text-destructive" },
  stopped: { label: "Stopped", dot: "bg-muted-foreground", text: "text-foreground" },
  paused: { label: "Paused", dot: "bg-muted-foreground" },
  ready: { label: "Ready", dot: "border border-line-strong bg-card" },
  waiting: { label: "Waiting", dot: "bg-line-strong" },
};

export function TaskList({ tasks }: { tasks: TaskRow[] }) {
  return (
    <ol className="grid gap-2.5">
      {tasks.map((t) => (
        <TaskItem key={t.id} task={t} />
      ))}
    </ol>
  );
}

function TaskItem({ task }: { task: TaskRow }) {
  const open = useOpenThread();
  const { state, thread, outcome, spend } = task;
  const s = STATE[state];
  const title = taskTitle(task.id);
  // Until the check thread starts, the newest thread is the finished worker: no clock then.
  const live = (state === "running" || state === "checking") && thread?.status === "running";
  // A working row's clock is on its second line: spend's wall time stops at the last event. A
  // run logged before model usage was recorded has times but no cost.
  const spent = [
    spend && (spend.calls > 0 || spend.unknownCostCalls > 0) && costLabel(spend),
    spend && !live && formatDuration(spend.wallSeconds),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${s.dot}`} aria-hidden="true" />
        {thread ? (
          <button
            type="button"
            title={title}
            onClick={() => open(thread.id)}
            className="min-w-0 truncate text-left text-ui font-medium hover:text-primary-text hover:underline"
          >
            {title}
          </button>
        ) : (
          <span
            title={title}
            className={`min-w-0 truncate text-ui ${state === "waiting" ? "text-muted-foreground" : "font-medium"}`}
          >
            {title}
          </span>
        )}
        <span className="ml-auto" />
        {spent && (
          <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{spent}</span>
        )}
        {spend && spend.calls > 0 && (
          <InfoButton
            label={`${title}: cost and time`}
            sections={[{ title: `${title}: worker, check and any redo`, rows: spendRows(spend) }]}
          />
        )}
      </div>
      <p
        title={outcome}
        className="mt-0.5 line-clamp-2 pl-4 text-meta text-muted-foreground [overflow-wrap:anywhere]"
      >
        {live && thread ? (
          <>
            {s.label} · <Elapsed thread={thread} />
          </>
        ) : outcome ? (
          <>
            <span className={s.text ? `font-medium ${s.text}` : "sr-only"}>{s.label}: </span>
            {outcome}
          </>
        ) : task.waitingOn?.length ? (
          `Waiting on ${task.waitingOn.map(taskTitle).join(", ")}`
        ) : (
          <span className={s.text}>{s.label}</span>
        )}
      </p>
    </li>
  );
}

export function OutputList({ outputs }: { outputs: OutputRow[] }) {
  return (
    <section aria-label="Outputs so far" className="mt-5">
      <h3 className="mb-1.5 text-ui font-medium">Outputs so far</h3>
      {outputs.length === 0 ? (
        <p className="text-meta text-muted-foreground">Values appear here as tasks report them.</p>
      ) : (
        <dl className="grid gap-1 text-ui">
          {outputs.map((o) => (
            <div key={o.id} className="flex min-w-0 items-baseline gap-3">
              <dt className="min-w-0 flex-1">
                {o.title}
                {o.reason && (
                  <span className="block text-meta text-muted-foreground">{o.reason}</span>
                )}
              </dt>
              <dd
                className={`shrink-0 text-right tabular-nums ${o.value === null ? "text-muted-foreground" : ""}`}
              >
                {o.value ?? "—"}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
