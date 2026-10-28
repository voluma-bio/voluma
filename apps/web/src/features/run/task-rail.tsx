/** The compact task list: progress at a glance, each row opening the task's newest thread. */
import type { FoldedTask } from "@voluma/contracts/fold";
import type { WorkflowPlan } from "@voluma/contracts/workflow";
import { StatusBadge } from "@voluma/ui";
import { Link } from "react-router";
import { threadHref } from "./feed";
import type { Thread } from "./run-feed";
import { taskStatus } from "./status";
import { taskTitle } from "./workflows";

export function TaskRail({
  plan,
  folded,
  threadByTask,
  openThread,
  ended,
}: {
  plan: WorkflowPlan | undefined;
  folded: FoldedTask[];
  threadByTask: Map<string, Thread>;
  openThread: string | null;
  ended: boolean;
}) {
  if (!plan) {
    return (
      <p className="text-ui text-muted-foreground">
        {ended
          ? "This run ended before it made a plan."
          : "The task list appears when the run starts."}
      </p>
    );
  }
  const byId = new Map(folded.map((t) => [t.id, t]));
  const done = plan.tasks.filter((t) => byId.get(t.id)?.status === "done").length;
  const toCheck = plan.tasks.filter((t) => byId.get(t.id)?.status === "to-check").length;
  return (
    <nav aria-label="Tasks">
      <h2 className="mb-2 text-ui font-medium">
        Tasks{" "}
        <span className="font-normal text-muted-foreground">
          {done} of {plan.tasks.length} done{toCheck > 0 && `, ${toCheck} to check`}
        </span>
      </h2>
      <ol className="grid gap-1">
        {plan.tasks.map((t) => {
          const { label, tone } = taskStatus(byId.get(t.id)?.status);
          const thread = threadByTask.get(t.id);
          const row = (
            <>
              <span className="min-w-0 flex-1 truncate">{taskTitle(t.id)}</span>
              <StatusBadge tone={tone}>{label}</StatusBadge>
            </>
          );
          const cls = "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-ui";
          return (
            <li key={t.id}>
              {thread ? (
                <Link
                  to={threadHref(thread.id)}
                  aria-current={thread.id === openThread ? "true" : undefined}
                  className={`${cls} hover:bg-accent aria-[current]:bg-accent`}
                >
                  {row}
                </Link>
              ) : (
                <div className={`${cls} text-muted-foreground`}>{row}</div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
