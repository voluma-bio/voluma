/**
 * What the run spent, from `spend(events)`: the run's total in the header, with the main thread's
 * share behind its info button, and the rows every spend popover lists (a task's in the Tasks
 * list, a worker's or checker's own included).
 */
import { cacheHitShare, type RunSpend, type Spend } from "@voluma/contracts/spend";
import { formatDuration, formatUsd } from "@voluma/ui/run";
import { InfoButton, type InfoSection } from "./chat/info-button";
import { useNow } from "./status";

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
