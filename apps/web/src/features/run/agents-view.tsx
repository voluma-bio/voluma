/**
 * The Agents view (`?view=agents`, `&agent=<threadId>`): every agent of the run as a tree, and the
 * selected agent's thread (`AgentThread`), live or afterwards. Follow live (no `agent`) shows
 * whichever agent is working now. The tree is `agentTree` (the log's own parent links); this file
 * groups siblings by task. Visuals are a thin debug layer on purpose: the redesign restyles it.
 */
import {
  AgentMark,
  type AgentNode,
  AgentThread,
  agentLabel,
  agentTree,
  STATUS_WORD,
  type Thread,
  useThreads,
} from "@voluma/run-view";
import { catalog } from "@voluma/workflow/bundled";
import { useEffect, useMemo, useRef } from "react";

const { taskTitle } = catalog["mouse-oa"];

/**
 * Which agent Follow live shows: the one it showed while that one still works, else the agent
 * that started working most recently and has no working agent under it, else the lead AI (a run
 * from before the lead AI has none: then the first agent).
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
  return (
    leaf ?? threads.find((t) => t.kind === "main") ?? threads.find((t) => t.kind !== "supervisor")
  );
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
  agentId,
  select,
  ended,
}: {
  /** The agent the reader picked; none means Follow live. */
  agentId: string | undefined;
  /** Picks an agent (and stops following), or with `null` turns Follow live on. */
  select: (threadId: string | null) => void;
  ended: boolean;
}) {
  const threads = useThreads();
  const follow = agentId === undefined;
  const tree = useMemo(() => agentTree(threads), [threads]);
  // The agent on screen at the last commit: turning Follow live on keeps it while it works.
  const shown = useRef<string | undefined>(undefined);
  const selected = follow
    ? followTarget(threads, shown.current)
    : (threads.find((t) => t.id === agentId) ?? followTarget(threads, undefined));
  useEffect(() => {
    shown.current = selected?.id;
  });

  if (!selected)
    return (
      <p className="text-ui text-muted-foreground">
        {ended
          ? "No agent started in this run."
          : "Nothing yet: the agents start when the run does."}
      </p>
    );
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[17rem_minmax(0,1fr)] gap-6 max-[1100px]:grid-cols-1">
      <nav aria-label="Agents" className="min-h-0 min-w-0 overflow-y-auto max-[1100px]:max-h-80">
        <ul className="grid gap-0.5">
          <Branch
            nodes={tree}
            selected={selected.id}
            follow={follow}
            threads={threads}
            select={select}
          />
        </ul>
      </nav>
      <AgentThread
        key={selected.id}
        threadId={selected.id}
        className="max-[1100px]:max-h-[36rem]"
        actions={
          <label className="flex items-center gap-1.5 text-meta">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => select(e.target.checked ? null : selected.id)}
            />
            Follow live
          </label>
        }
      />
    </div>
  );
}

type TreeProps = {
  selected: string;
  follow: boolean;
  threads: Thread[];
  select: (threadId: string) => void;
};

/** Sibling agents, those sharing a task under its title. */
function Branch({ nodes, ...props }: TreeProps & { nodes: AgentNode[] }) {
  return byTask(nodes).map((g) =>
    g.taskId ? (
      <li key={g.taskId} className="min-w-0">
        <p className="truncate px-2 pt-2 pb-0.5 text-meta font-medium text-muted-foreground">
          {taskTitle(g.taskId)}
        </p>
        <ul className="grid gap-0.5">
          {g.nodes.map((n) => (
            <TreeNode key={n.thread.id} node={n} {...props} />
          ))}
        </ul>
      </li>
    ) : (
      g.nodes.map((n) => <TreeNode key={n.thread.id} node={n} {...props} />)
    ),
  );
}

function TreeNode({ node, ...props }: TreeProps & { node: AgentNode }) {
  const t = node.thread;
  const current = t.id === props.selected;
  const row = useRef<HTMLButtonElement>(null);
  // Follow live can pick an agent below the tree's fold: bring it into view.
  useEffect(() => {
    if (current && props.follow) row.current?.scrollIntoView({ block: "nearest" });
  }, [current, props.follow]);
  return (
    <li className="min-w-0">
      <button
        ref={row}
        type="button"
        aria-current={current ? "true" : undefined}
        onClick={() => props.select(t.id)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-ui hover:bg-muted aria-[current]:bg-muted aria-[current]:font-medium"
      >
        <AgentMark thread={t} />
        <span className="min-w-0 flex-1 truncate">{agentLabel(t, props.threads)}</span>
        <span className="sr-only">{STATUS_WORD[t.status]}</span>
      </button>
      {node.children.length > 0 && (
        <ul className="ml-3 grid gap-0.5 border-l border-border pl-2">
          <Branch nodes={node.children} {...props} />
        </ul>
      )}
    </li>
  );
}
