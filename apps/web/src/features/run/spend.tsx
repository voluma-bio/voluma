/**
 * What the run spent, from `spend(events)`: the run's total in the header, with the main thread's
 * share behind its info button, each task's cost and wall time under the plan, and the rows every
 * spend popover lists (a worker's or checker's own included).
 */
import { cacheHitShare, type RunSpend, type Spend } from "@voluma/contracts/spend";
import { InfoButton, type InfoSection } from "./chat/info-button";
import { formatDuration, formatUsd, useNow } from "./status";
import { taskTitle } from "./workflows";

const count = (n: number) => n.toLocaleString();

/**
 * Cost, wall time (unless `wall` is false: the main thread's is the run's, and a card's clock is
 * its thread's), command time, then calls and tokens.
 */
export function spendRows(s: Spend, { wall = true }: { wall?: boolean } = {}): InfoSection["rows"] {
  const hit = cacheHitShare(s);
  const rows: InfoSection["rows"] = [["Cost", formatUsd(s.costUsd)]];
  if (s.toolCostUsd > 0) rows.push(["Paid tools", formatUsd(s.toolCostUsd)]);
  if (wall) rows.push(["Wall time", formatDuration(s.wallSeconds)]);
  // `bash` calls only: the runs list's sandbox time is the sandbox's uptime, which is longer.
  rows.push(["Command time", formatDuration(s.sandboxSeconds)]);
  rows.push(
    ["Model calls", count(s.calls)],
    ["Input tokens", count(s.input + s.cacheRead)],
    ["Output tokens", count(s.output)],
    ["Cache hit", hit === null ? "none" : `${Math.round(100 * hit)}%`],
    ["Cache writes", count(s.cacheWrite)],
  );
  return rows;
}

/**
 * "$0.412 · 6 min 3 s": what the run has spent so far, with the main thread's part on hover.
 * `since`, while the runner is running the run, is the latest event's time: spend's wall time
 * stops there, so the clock counts on from it each second.
 */
export function RunSpendSummary({ spend, since }: { spend: RunSpend; since?: string }) {
  const now = useNow(since !== undefined);
  if (spend.total.calls === 0) return null;
  const total = since
    ? {
        ...spend.total,
        wallSeconds: spend.total.wallSeconds + Math.max(0, now - Date.parse(since)) / 1000,
      }
    : spend.total;
  return (
    <span className="flex items-center gap-1 text-ui text-muted-foreground tabular-nums">
      {formatUsd(total.costUsd)} · {formatDuration(total.wallSeconds)}
      <InfoButton
        label="Run cost and time"
        sections={[
          { title: "Whole run", rows: spendRows(total) },
          { title: "Main thread", rows: spendRows(spend.main, { wall: false }) },
        ]}
      />
    </span>
  );
}

/** One row per task that has started, in start order: its worker, check and any redo together. */
export function TaskSpendList({ spend }: { spend: RunSpend }) {
  if (spend.tasks.length === 0) return null;
  return (
    <section aria-label="Cost and time by task" className="mt-5">
      <h3 className="mb-1.5 text-ui font-medium">Cost and time</h3>
      <ul className="grid gap-0.5 text-ui">
        {spend.tasks.map(({ taskId, spend: s }) => {
          const title = taskTitle(taskId);
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
