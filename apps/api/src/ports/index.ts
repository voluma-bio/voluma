/**
 * Interfaces both API domains depend on: what one domain reads from the other (index.ts
 * wires it; a domain never imports the other), and shared adapters such as blob storage.
 * The run domain's EventLog and History ports live in packages/harness, which the Node
 * runner shares; the Sandbox port too, since the runner, not the API, creates sandboxes. Adapters of these shared ports
 * go in adapters/ (none yet); a domain's own Postgres adapters live in the domain. Only
 * index.ts constructs adapters.
 * Owned by both lanes; change in small PRs.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { Run } from "@voluma/contracts/run";
import type { Reader } from "../domain";

/** The run domain's record of a run, for the review: the run and its whole event log. */
export type RunRecords = {
  /** The run and every stored event, in `seq` order; null when `reader` can't read the run. */
  load(reader: Reader, runId: string): Promise<{ run: Run; events: RunEvent[] } | null>;
};
