/**
 * The Agents view (`?view=agents`, `&agent=<threadId>`): every agent of the run as a tree, and the
 * selected agent's stream, live or afterwards. Follow live shows whichever agent is working now.
 * The tree is `agentTree` (the log's own parent links); this file only groups siblings by task
 * and names them. Visuals are a thin debug layer on purpose: the redesign restyles it.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { catalog } from "@voluma/workflow/bundled";
import { useEffect, useMemo, useRef } from "react";
import { AgentMark, Elapsed, STATUS_WORD, ThreadSpendInfo } from "./agents";
import { type AgentNode, agentTree, type Thread } from "./run-model";
import { type Halt, type Live, mainRows, threadRows } from "./transcript";
import { TranscriptView } from "./transcript-view";

const { taskTitle } = catalog["mouse-oa"];

/**
 * Which agent Follow live shows: the one it showed while that one still works, else the agent
 * that started working most recently and has no working agent under it, else the lead AI.
 */
function followTarget(threads: Thread[], previous: string | undefined): Thread | undefined {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const kept = previous ? byId.get(previous) : undefined;
  if (kept?.status === "running") return kept;
  const working = threads.filter((t) => t.kind !== "supervisor" && t.status === "running");
  const busyParents = new Set(working.map((t) => t.parentId));
  const leaf = working
    .filter((t) => !busyParents.has(t.id))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return leaf ?? threads.find((t) => t.kind === "main") ?? kept;
}

/** What an agent is called among its siblings, where its task is already the group's heading. */
function agentLabel(t: Thread, tryOf: Map<string, { n: number; of: number }>): string {
  switch (t.kind) {
    case "main":
      return "Lead AI";
    case "worker":
      return t.attempts.length > 1 ? `The AI's work, ${t.attempts.length} tries` : "The AI's work";
    case "check": {
      const at = t.attemptId ? tryOf.get(t.attemptId) : undefined;
      return at && at.of > 1 ? `Second AI check of try ${at.n}` : "Second AI check";
    }
    case "chat":
      return "Chat";
    default:
      return t.kind;
  }
}

/** Siblings that share a task sit under its title, in the order their first one started. */
function byTask(children: AgentNode[]): { taskId?: string; nodes: AgentNode[] }[] {
  const groups: { taskId?: string; nodes: AgentNode[] }[] = [];
  for (const node of children) {
    const taskId = node.thread.taskId;
    const group = taskId ? groups.find((g) => g.taskId === taskId) : undefined;
    if (group) group.nodes.push(node);
    else groups.push({ taskId, nodes: [node] });
  }
  return groups;
}

export function AgentsView({
  threads,
  events,
  live,
  halt,
  agentId,
  follow,
  select,
}: {
  threads: Thread[];
  events: RunEvent[];
  live: Live;
  halt: Halt | undefined;
  /** The agent the reader picked; ignored while following. */
  agentId: string | undefined;
  follow: boolean;
  /** Picks an agent (and stops following), or with `null` turns Follow live on. */
  select: (threadId: string | null) => void;
}) {
  const tree = useMemo(() => agentTree(threads), [threads]);
  const tryOf = useMemo(() => {
    const m = new Map<string, { n: number; of: number }>();
    for (const t of threads)
      t.attempts.forEach((a, i) => {
        m.set(a, { n: i + 1, of: t.attempts.length });
      });
    return m;
  }, [threads]);
  const followed = useRef<string | undefined>(undefined);
  const target = follow ? followTarget(threads, followed.current) : undefined;
  followed.current = target?.id;
  const selected =
    target ?? threads.find((t) => t.id === agentId) ?? followTarget(threads, undefined);

  if (!selected)
    return (
      <p className="text-ui text-muted-foreground">
        Nothing yet: the lead AI starts when the run does.
      </p>
    );
  return (
    <div className="grid grid-cols-[17rem_minmax(0,1fr)] gap-6 max-[1100px]:grid-cols-1">
      <nav
        aria-label="Agents"
        className="sticky top-0 max-h-[calc(100vh-12rem)] min-w-0 self-start overflow-y-auto max-[1100px]:static max-[1100px]:max-h-none"
      >
        <ul className="grid gap-0.5">
          {tree.map((node) => (
            <TreeNode
              key={node.thread.id}
              node={node}
              selected={selected.id}
              tryOf={tryOf}
              select={select}
            />
          ))}
        </ul>
      </nav>
      <Stream
        thread={selected}
        threads={threads}
        label={
          selected.taskId
            ? `${taskTitle(selected.taskId)}: ${agentLabel(selected, tryOf)}`
            : agentLabel(selected, tryOf)
        }
        events={events}
        live={live}
        halt={halt}
        follow={follow}
        setFollow={(on) => select(on ? null : selected.id)}
      />
    </div>
  );
}

function TreeNode({
  node,
  selected,
  tryOf,
  select,
}: {
  node: AgentNode;
  selected: string;
  tryOf: Map<string, { n: number; of: number }>;
  select: (threadId: string) => void;
}) {
  const t = node.thread;
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-current={t.id === selected ? "true" : undefined}
        onClick={() => select(t.id)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-ui hover:bg-muted aria-[current]:bg-muted aria-[current]:font-medium"
      >
        <AgentMark thread={t} />
        <span className="min-w-0 flex-1 truncate">{agentLabel(t, tryOf)}</span>
        <span className="sr-only">{STATUS_WORD[t.status]}</span>
      </button>
      {node.children.length > 0 && (
        <ul className="ml-3 grid gap-0.5 border-l border-border pl-2">
          {byTask(node.children).map((g) =>
            g.taskId ? (
              <li key={g.taskId} className="min-w-0">
                <p className="truncate px-2 pt-2 pb-0.5 text-meta font-medium text-muted-foreground">
                  {taskTitle(g.taskId)}
                </p>
                <ul className="grid gap-0.5">
                  {g.nodes.map((n) => (
                    <TreeNode
                      key={n.thread.id}
                      node={n}
                      selected={selected}
                      tryOf={tryOf}
                      select={select}
                    />
                  ))}
                </ul>
              </li>
            ) : (
              g.nodes.map((n) => (
                <TreeNode
                  key={n.thread.id}
                  node={n}
                  selected={selected}
                  tryOf={tryOf}
                  select={select}
                />
              ))
            ),
          )}
        </ul>
      )}
    </li>
  );
}

function Stream({
  thread,
  threads,
  label,
  events,
  live,
  halt,
  follow,
  setFollow,
}: {
  thread: Thread;
  /** For the lead AI's stream: the agents its cards show. */
  threads: Thread[];
  label: string;
  events: RunEvent[];
  live: Live;
  halt: Halt | undefined;
  follow: boolean;
  setFollow: (on: boolean) => void;
}) {
  const rows = useMemo(
    () =>
      thread.kind === "main"
        ? mainRows(events, live, halt)
        : threadRows(events, thread.id, live, halt),
    [thread.kind, thread.id, events, live, halt],
  );
  const threadById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const running = thread.status === "running";
  const end = useRef<HTMLDivElement>(null);
  // While following, keep the newest line in view as it streams.
  useEffect(() => {
    if (follow && running && rows.length > 0) end.current?.scrollIntoView({ block: "end" });
  }, [follow, running, rows]);
  const answer = running
    ? (thread.liveTool ?? thread.lastTool)
    : (thread.error ?? thread.result?.text);
  return (
    <section className="min-w-0">
      <header className="mb-4 grid gap-1 border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate text-lg font-semibold">{label}</h2>
          <span className="shrink-0 text-meta text-muted-foreground">
            {STATUS_WORD[thread.status]}
          </span>
          <Elapsed thread={thread} />
          <ThreadSpendInfo thread={thread} />
          <label className="ml-auto flex shrink-0 items-center gap-1.5 text-meta">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow live
          </label>
        </div>
        {answer && <p className="truncate text-meta text-muted-foreground">{answer}</p>}
      </header>
      <TranscriptView
        rows={rows}
        threads={thread.kind === "main" ? threadById : undefined}
        live={running ? (thread.liveTool ?? "") : null}
        empty={running ? "Nothing yet." : "It wrote nothing."}
      />
      <div ref={end} />
    </section>
  );
}
