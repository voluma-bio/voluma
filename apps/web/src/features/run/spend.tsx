/**
 * What the run spent, from `spend(events)`: the run's total in the header, with the main thread's
 * share behind its info button, and each task's cost and wall time under the plan.
 */
import { cacheHitShare, type RunSpend, type Spend } from "@voluma/contracts/spend";
import type { WorkflowPlan } from "@voluma/contracts/workflow";
import { InfoButton, type InfoSection } from "./chat/info-button";
import { formatDuration, formatUsd } from "./status";

const count = (n: number) => n.toLocaleString();

/** Cost, then time (unless `times` is false), then calls and tokens. */
function spendRows(s: Spend, times = true): InfoSection["rows"] {
  const hit = cacheHitShare(s);
  const rows: InfoSection["rows"] = [["Cost", formatUsd(s.costUsd)]];
  if (s.toolCostUsd > 0) rows.push(["Paid tools", formatUsd(s.toolCostUsd)]);
  if (times)
    rows.push(
      ["Wall time", formatDuration(s.wallSeconds)],
      ["Sandbox time", formatDuration(s.sandboxSeconds)],
    );
  return [
    ...rows,
    ["Model calls", count(s.calls)],
    ["Input tokens", count(s.input + s.cacheRead)],
    ["Output tokens", count(s.output)],
    ["Cache hit", hit === null ? "none" : `${Math.round(100 * hit)}%`],
    ["Cache writes", count(s.cacheWrite)],
  ];
}

/** "$0.412 · 6 min 3 s": what the run has spent so far, with the main thread's part on hover. */
export function RunSpendSummary({ spend }: { spend: RunSpend }) {
  if (spend.total.calls === 0) return null;
  return (
    <span className="flex items-center gap-1 text-ui text-muted-foreground tabular-nums">
      {formatUsd(spend.total.costUsd)} · {formatDuration(spend.total.wallSeconds)}
      <InfoButton
        label="Run cost and time"
        sections={[
          { title: "Whole run", rows: spendRows(spend.total) },
          // The main thread's span is the run's own, so its times repeat the run's.
          { title: "Main thread", rows: spendRows(spend.main, false) },
        ]}
      />
    </span>
  );
}

/**
 * One row per task that has started, in start order: its worker, check and any redo together.
 * Labelled by the run's own plan, so a run shows the titles it ran with.
 */
export function TaskSpendList({ spend, plan }: { spend: RunSpend; plan: WorkflowPlan }) {
  if (spend.tasks.length === 0) return null;
  const titles = new Map(plan.tasks.map((t) => [t.id, t.title ?? t.id]));
  return (
    <section aria-label="Cost and time by task" className="mt-5">
      <h3 className="mb-1.5 text-ui font-medium">Cost and time</h3>
      <ul className="grid gap-0.5 text-ui">
        {spend.tasks.map(({ taskId, spend: s }) => {
          const title = titles.get(taskId) ?? taskId;
          return (
            <li key={taskId} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatUsd(s.costUsd)} · {formatDuration(s.wallSeconds)}
              </span>
              <InfoButton
                label={`${title}: cost and time`}
                sections={[{ title: `${title}: worker, check and any redo`, rows: spendRows(s) }]}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
