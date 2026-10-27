/**
 * Run lane's API domain, mounted at /run/: workflows and their package
 * import, runs, the agent runtime (Pi's agent layer), the
 * supervisor, the thread store. RunDeps lists the ports it
 * needs; index.ts supplies adapters.
 */
import type { DomainHandler } from "../../domain";

export type RunDeps = Record<string, never>;

export function createRun(_deps: RunDeps): DomainHandler {
  return () => null;
}
