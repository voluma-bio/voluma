/**
 * What an agent, a task or one reply took, tried and cost, behind an info button (`@voluma/ui`'s
 * `InfoButton`): the numbers someone asks for when a run looks slow or dear, kept off the review
 * itself. A running thread's clock ticks only while its popover is open.
 */
import type { ModelUsage } from "@voluma/contracts/events";
import { cacheHitShare, type Spend } from "@voluma/contracts/spend";
import { type FactSection, FactSections, Facts, InfoButton } from "@voluma/ui";
import { type TaskView, type Thread, workedSeconds } from "./run-model";
import { formatDuration, formatUsd, plural } from "./run-status";
import { useNow } from "./use-now";

const count = (n: number) => n.toLocaleString();

/** Cost, command time, then calls and tokens; wall time is the caller's. */
function spendItems(s: Spend): FactSection["items"] {
  const hit = cacheHitShare(s);
  const items: FactSection["items"] = [["Cost", formatUsd(s.costUsd)]];
  if (s.unknownCostCalls > 0)
    items.push(["Cost unknown", plural(s.unknownCostCalls, "gateway request")]);
  if (s.toolCostUsd > 0) items.push(["Paid tools", formatUsd(s.toolCostUsd)]);
  // `bash` calls only: the run's sandbox time is the sandboxes' uptime, which is longer.
  items.push(
    ["Command time", formatDuration(s.sandboxSeconds)],
    ["Model calls", count(s.calls)],
    ["Input tokens", count(s.input + s.cacheRead)],
    ["Output tokens", count(s.output)],
    ["Cache hit", hit === null ? "none" : `${Math.round(100 * hit)}%`],
    ["Cache misses", count(s.cacheMisses)],
    ["Cache writes", count(s.cacheWrite)],
  );
  return items;
}

const took = (seconds: number, live: boolean): [string, string] =>
  live ? ["Running for", formatDuration(seconds)] : ["Took", formatDuration(seconds)];

function ThreadFacts({ thread }: { thread: Thread }) {
  const running = thread.status === "running";
  const now = useNow(running);
  const tools = `${count(thread.toolCalls)}${thread.toolErrors > 0 ? `, ${count(thread.toolErrors)} failed` : ""}`;
  return (
    <FactSections
      sections={[
        {
          items: [
            took(workedSeconds(thread, now), running),
            ...(thread.attempts.length > 1
              ? [["Tries", String(thread.attempts.length)] as [string, string]]
              : []),
            ["Tool calls", tools],
          ],
        },
        ...(thread.spend?.calls
          ? [{ title: thread.model ?? "Model use", items: spendItems(thread.spend) }]
          : []),
      ]}
    />
  );
}

/** An agent's clock, tries, tool calls and model use. */
export function ThreadInfo({ thread }: { thread: Thread }) {
  return (
    <InfoButton label="Agent details">
      <ThreadFacts thread={thread} />
    </InfoButton>
  );
}

function TaskFacts({ task }: { task: TaskView }) {
  const working = task.state === "running" || task.state === "checking";
  const now = useNow(working);
  const seconds = task.threads.reduce((sum, t) => sum + workedSeconds(t, now), 0);
  const tries = Math.max(0, ...task.threads.map((t) => t.attempts.length));
  return (
    <FactSections
      sections={[
        {
          items: [
            took(seconds, working),
            ...(tries > 1 ? [["Tries", String(tries)] as [string, string]] : []),
            ["Agents", String(task.threads.length)],
          ],
        },
        ...(task.spend?.calls ? [{ title: "Model use", items: spendItems(task.spend) }] : []),
      ]}
    />
  );
}

/** A task's working time over its agents, its tries and its model use; none before an agent starts. */
export function TaskInfo({ task }: { task: TaskView }) {
  if (task.threads.length === 0) return null;
  return (
    <InfoButton label="Task details">
      <TaskFacts task={task} />
    </InfoButton>
  );
}

/** One model reply's tokens, the share read from cache, whether it missed the cache, and its cost. */
export function ReplyInfo({ usage: u, miss = false }: { usage: ModelUsage; miss?: boolean }) {
  const read = u.input + u.cacheRead;
  const items: FactSection["items"] = [
    ["Input tokens", count(read)],
    ["Output tokens", count(u.output)],
    ["Cache hit", read > 0 ? `${Math.round((100 * u.cacheRead) / read)}%` : "none"],
    ...(miss ? ([["Cache", "miss"]] as FactSection["items"]) : []),
    ["Cache writes", count(u.cacheWrite)],
    ["Cost", formatUsd(u.costUsd)],
  ];
  return (
    <InfoButton label="Reply details">
      <Facts items={items} />
    </InfoButton>
  );
}
