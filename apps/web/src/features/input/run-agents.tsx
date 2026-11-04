/**
 * The run's workers, a tab of the side panel: a list in start order, or the picked worker's whole
 * thread with a way back to the list. Main is not here: the Conversation is its thread. From
 * `agentEntries` (`@voluma/run-view`) on the agent log; the pick is the URL's `agent`. Only the
 * picked thread's rows are built.
 */

import type { AgentState } from "@voluma/contracts/agents";
import type { RunEvent } from "@voluma/contracts/events";
import { type AgentEntry, AgentThread, clockOf } from "@voluma/run-view";
import { Button, type Status, StatusGlyph } from "@voluma/ui";
import { ChevronLeft } from "lucide-react";

const NOW: Record<AgentState, string> = {
  working: "Working",
  idle: "Waiting",
  closing: "Winding up",
  closed: "Done",
  failed: "Failed",
  "cut-off": "Cut off",
};

const wordOf = (a: AgentEntry, live: boolean) =>
  a.stopped ? "Stopped" : a.state === "idle" && !live ? "Done" : NOW[a.state];

const MARK: Record<AgentState, Status> = {
  working: "running",
  idle: "waiting",
  closing: "running",
  closed: "done",
  failed: "stopped",
  "cut-off": "stopped",
};

/** An idle agent of an ended run is done, as its word says. */
const markOf = (a: AgentEntry, live: boolean): Status =>
  a.state === "idle" && !live ? "done" : MARK[a.state];

const worked = (a: AgentEntry) => `${clockOf(a.from)}${a.to ? `–${clockOf(a.to)}` : ""}`;

export function RunAgents({
  events,
  agents,
  picked,
  onPick,
  onBack,
  live,
  nameOf,
}: {
  events: readonly RunEvent[];
  agents: readonly AgentEntry[];
  /** The URL's `agent`, if any. */
  picked: string | null;
  onPick: (name: string) => void;
  /** Back to the list. */
  onBack: () => void;
  /** The run hasn't ended. */
  live: boolean;
  nameOf: (id: string) => string;
}) {
  if (agents.length === 0)
    return <p className="p-4 text-sm text-muted-foreground">No worker has started yet.</p>;
  const agent = picked === null ? undefined : agents.find((a) => a.names.includes(picked));
  if (!agent)
    return (
      <nav aria-label="Agents" className="overflow-y-auto py-1">
        <ul>
          {agents.map((a) => (
            <li key={a.name}>
              <button
                type="button"
                onClick={() => onPick(a.name)}
                className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-ui hover:bg-accent"
              >
                <span className={a.state === "working" ? "text-info" : "text-fg-subtle"}>
                  <StatusGlyph status={markOf(a, live)} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono">{a.name}</span>
                  <span className="block truncate text-meta text-muted-foreground tabular-nums">
                    {wordOf(a, live)} · {worked(a)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    );
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="grid shrink-0 gap-0.5 border-b border-border px-3 py-2">
        <Button variant="ghost" size="sm" className="-ml-2 justify-self-start" onClick={onBack}>
          <ChevronLeft aria-hidden />
          All agents
        </Button>
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="min-w-0 truncate font-mono text-base font-semibold">{agent.name}</h2>
          <span className="shrink-0 text-meta text-muted-foreground">{wordOf(agent, live)}</span>
        </div>
        <p className="text-meta text-muted-foreground tabular-nums">
          Worked {worked(agent)}
          {" · "}
          {agent.made.length > 0 ? (
            <>Reported {agent.made.map(nameOf).join(", ")}</>
          ) : (
            "Reported nothing"
          )}
        </p>
      </header>
      <AgentThread
        key={agent.name}
        className="flex-1 px-3 py-3"
        events={events}
        ids={agent.ids}
        working={live && agent.state === "working"}
        live={live}
      />
    </section>
  );
}
