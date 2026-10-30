/**
 * Agents: every agent of the run as the log places them (`agentTree`), the lead AI first and the
 * agents it started grouped by task, then the picked agent's steps (`AgentThread`). Follow live
 * (no agent picked) shows whichever agent is working now.
 */
import {
  type AgentNode,
  AgentThread,
  agentLabel,
  agentTree,
  Elapsed,
  THREAD_STATUS,
  type Thread,
  useThreads,
} from "@voluma/run-view";
import { EmptyState, List, Row, type Status, StatusGlyph } from "@voluma/ui";
import { catalog } from "@voluma/workflow/bundled";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";

const { taskTitle } = catalog["mouse-oa"];

/**
 * Which agent Follow live shows: the one it showed while that one still works, else the agent
 * that started working most recently and has no working agent under it, else the first agent of
 * the tree (the lead AI). `agents` is the tree read top down.
 */
function followTarget(agents: Thread[], previous: string | undefined): Thread | undefined {
  const kept = previous ? agents.find((t) => t.id === previous) : undefined;
  if (kept?.status === "running") return kept;
  const working = agents.filter((t) => t.status === "running");
  const busyParents = new Set(working.map((t) => t.parentId));
  const leaf = working
    .filter((t) => !busyParents.has(t.id))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return leaf ?? agents[0];
}

/** A node and everything under it, in start order. */
const flatten = (node: AgentNode): Thread[] => [node.thread, ...node.children.flatMap(flatten)];

/**
 * The tree read top down, agents of one task gathered under it where its first agent started;
 * agents with no task (the lead AI) stand alone.
 */
function groups(agents: Thread[]) {
  const out: { key: string; taskId?: string; threads: Thread[] }[] = [];
  for (const t of agents) {
    const group = t.taskId ? out.find((g) => g.taskId === t.taskId) : undefined;
    if (group) group.threads.push(t);
    else out.push({ key: t.id, taskId: t.taskId, threads: [t] });
  }
  return out;
}

export function AgentsPanel({
  agentId,
  onAgent,
  ended,
}: {
  /** The agent picked; none follows the one working now. */
  agentId: string | undefined;
  /** Picks an agent, or with `null` follows live. */
  onAgent: (threadId: string | null) => void;
  ended: boolean;
}) {
  const threads = useThreads();
  // The tree holds the agents that run a model; reading it top down keeps the log's order.
  const agents = useMemo(() => agentTree(threads).flatMap(flatten), [threads]);
  const tree = useMemo(() => groups(agents), [agents]);
  const follow = agentId === undefined;
  const shown = useRef<string | undefined>(undefined);
  const selected = follow
    ? followTarget(agents, shown.current)
    : (agents.find((t) => t.id === agentId) ?? followTarget(agents, undefined));
  useEffect(() => {
    shown.current = selected?.id;
  });
  if (!selected)
    return (
      <div className="p-4">
        <EmptyState title={ended ? "No agent started in this run" : "No agents yet"}>
          {ended ? undefined : "The agents start when the run does."}
        </EmptyState>
      </div>
    );
  const count = agents.length;
  return (
    <div className="flex h-full flex-col">
      <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-border">
        <p className="px-4 pt-3 pb-1 text-sm text-muted-foreground">
          {count} {count === 1 ? "agent" : "agents"}
        </p>
        <List label="Agents" density="compact" columns="auto">
          {tree.map((g) =>
            g.taskId ? (
              <Row
                key={g.key}
                defaultOpen={g.threads.some((t) => t.id === selected.id)}
                title={
                  <Titled status={THREAD_STATUS[(g.threads.at(-1) as Thread).status]}>
                    {taskTitle(g.taskId)}
                  </Titled>
                }
                cells={[
                  <span key="n" className="text-xs text-muted-foreground">
                    {g.threads.length} {g.threads.length === 1 ? "agent" : "agents"}
                  </span>,
                ]}
              >
                <List columns="auto">
                  {g.threads.map((t) => (
                    <AgentRow
                      key={t.id}
                      thread={t}
                      threads={threads}
                      selected={selected}
                      pick={onAgent}
                    />
                  ))}
                </List>
              </Row>
            ) : (
              g.threads.map((t) => (
                <AgentRow
                  key={t.id}
                  thread={t}
                  threads={threads}
                  selected={selected}
                  pick={onAgent}
                />
              ))
            ),
          )}
        </List>
      </div>
      <AgentThread
        key={selected.id}
        threadId={selected.id}
        className="min-h-0 flex-1 px-4 pt-3"
        actions={
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => onAgent(e.target.checked ? null : selected.id)}
            />
            Follow live
          </label>
        }
      />
    </div>
  );
}

function AgentRow({
  thread,
  threads,
  selected,
  pick,
}: {
  thread: Thread;
  threads: Thread[];
  selected: Thread;
  pick: (threadId: string) => void;
}) {
  const verdict = thread.result?.verdict;
  return (
    <Row
      selected={thread.id === selected.id}
      title={<Titled status={THREAD_STATUS[thread.status]}>{agentLabel(thread, threads)}</Titled>}
      cells={[
        verdict === "needs-review" ? (
          <span key="v" className="text-xs text-check">
            Sent back
          </span>
        ) : verdict === "passed" ? (
          <span key="v" className="text-xs text-muted-foreground">
            Agreed
          </span>
        ) : (
          <Elapsed key="v" thread={thread} />
        ),
      ]}
      onSelect={() => pick(thread.id)}
    />
  );
}

/** A row's title led by its state's glyph. */
function Titled({ status, children }: { status: Status; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <StatusGlyph status={status} />
      <span className="truncate">{children}</span>
    </span>
  );
}
