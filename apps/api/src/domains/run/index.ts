/**
 * Run lane's API domain, mounted at /run/: workflows and their package
 * import, runs, the supervisor, the thread store and the MCP server the
 * agents call. RunDeps lists the ports it needs; index.ts supplies adapters.
 */
import type { DomainHandler } from "../../domain";

export type RunDeps = Record<string, never>;

export function createRun(_deps: RunDeps): DomainHandler {
  return () => null;
}
