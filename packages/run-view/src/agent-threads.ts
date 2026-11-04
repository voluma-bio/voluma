/**
 * The agents a researcher can open, from `workersOf` and the agent log: main first (only when the
 * run has one), then every worker or check in start order. Main is one entry however many
 * threads it took (`main` and each `main.N` a review began); the root runs no model and is not
 * listed. Place comes from `agentLog`, never from a thread's `kind` or `role`.
 */
import { agentLog } from "@voluma/contracts/agents";
import type { RunEvent } from "@voluma/contracts/events";
import type { OutputsFold } from "@voluma/contracts/output-fold";
import { type Worker, workersOf } from "./outputs-trail";

export type AgentEntry = Worker & {
  /** The thread ids it is made of, in log order: several only for main. */
  ids: string[];
  /** Every thread name it answers to (`main`, `main.2`). */
  names: string[];
  place: "main" | "worker";
};

export function agentEntries(
  events: readonly RunEvent[],
  fold: OutputsFold,
  live: boolean,
): AgentEntry[] {
  const records = agentLog(events).records;
  const entries = workersOf(events, fold, live).map(
    (w): AgentEntry => ({
      ...w,
      ids: [w.id],
      names: [w.name],
      place: records.get(w.id)?.place ?? "worker",
    }),
  );
  const mains = entries.filter((e) => e.place === "main");
  const first = mains[0];
  const last = mains.at(-1);
  if (!first || !last) return entries;
  const main: AgentEntry = {
    ...first,
    name: "main",
    ids: mains.map((m) => m.id),
    names: mains.map((m) => m.name),
    to: last.to,
    state: last.state,
    stopped: last.stopped,
    made: [...new Set(mains.flatMap((m) => m.made))],
  };
  return [main, ...entries.filter((e) => e.place !== "main")];
}

/** Main, else the agent working now, else the first. */
export const defaultAgent = (entries: readonly AgentEntry[]): AgentEntry | undefined =>
  entries.find((e) => e.place === "main") ??
  entries.find((e) => e.state === "working") ??
  entries[0];
