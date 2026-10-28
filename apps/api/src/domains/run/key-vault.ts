/**
 * Visitor keys, in this process's memory and nowhere else (`@voluma/contracts/run`,
 * "Starting work"). Held before a start or `/keys` commits, until a claim takes them or
 * the run is cancelled or refused. A process that doesn't hold a queued visitor run's
 * keys can't claim it, so the claim moves it to `awaiting-keys`. An org holds at most
 * `MAX_PER_ORG` runs' keys: a backstop for an org with no `VISITOR_ACTIVE` set (the visitor cap, queued and
 * running runs only, is the real bound), so a client can't pin unbounded memory. Never log, store or
 * return a value held here.
 */
import type { VisitorKeys } from "@voluma/contracts/run";

const MAX_PER_ORG = 100;

export class KeyVault {
  private readonly entries = new Map<string, { labId: string; keys: VisitorKeys }>();

  /** Holds the run's keys (replacing its earlier ones). False when the org is at its cap. */
  hold(runId: string, labId: string, keys: VisitorKeys): boolean {
    if (!this.entries.has(runId)) {
      let held = 0;
      for (const entry of this.entries.values()) if (entry.labId === labId) held++;
      if (held >= MAX_PER_ORG) return false;
    }
    this.entries.set(runId, { labId, keys });
    return true;
  }

  /** Ids with keys held, for the claim to choose among. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Hands the keys out once: the vault forgets them as it answers. */
  take(runId: string): VisitorKeys | undefined {
    const entry = this.entries.get(runId);
    this.entries.delete(runId);
    return entry?.keys;
  }

  drop(runId: string) {
    this.entries.delete(runId);
  }
}
