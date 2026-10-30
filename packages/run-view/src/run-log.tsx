/**
 * The run's log for everything below the run page that shows agents: durable events, live frames,
 * the halt and the threads (live tool calls applied). One `RunLogProvider` per run page; read with
 * `useRunLog`, so a thread can be shown anywhere without passing the log down.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { createContext, useContext } from "react";
import type { Thread } from "./run-model";
import type { Halt, Live } from "./transcript";

export type RunLog = {
  events: RunEvent[];
  live: Live;
  halt: Halt | undefined;
  /** Every thread of the run, live tool calls applied (`withLiveCalls`). */
  threads: Thread[];
};

const RunLogContext = createContext<RunLog | null>(null);

export const RunLogProvider = RunLogContext.Provider;

export function useRunLog(): RunLog {
  const log = useContext(RunLogContext);
  if (!log) throw new Error("useRunLog needs a RunLogProvider above it");
  return log;
}
