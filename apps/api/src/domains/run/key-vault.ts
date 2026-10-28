/**
 * Visitor keys, in this process's memory and nowhere else (`@voluma/contracts/run`,
 * "Starting work"). Held from `startRun` or `/keys` until a claim takes them, or the run
 * is cancelled. A restart empties it, which is why the API moves unclaimed visitor runs
 * to `awaiting-keys` on start. Never log, store or return a value held here.
 */
import type { VisitorKeys } from "@voluma/contracts/run";

export class KeyVault {
  private readonly keys = new Map<string, VisitorKeys>();

  set(runId: string, keys: VisitorKeys) {
    this.keys.set(runId, keys);
  }

  /** Ids with keys held, for the claim to choose among. */
  ids(): string[] {
    return [...this.keys.keys()];
  }

  /** Hands the keys out once: the vault forgets them as it answers. */
  take(runId: string): VisitorKeys | undefined {
    const keys = this.keys.get(runId);
    this.keys.delete(runId);
    return keys;
  }

  drop(runId: string) {
    this.keys.delete(runId);
  }
}
