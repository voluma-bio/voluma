/**
 * The lease check every ingest write makes: the write's token matches the run row and the
 * run is running. `LeaseLost` tells the runner to stop (the contract's 409 `lease-lost`).
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "./pg-runs";
import { runs } from "./schema";

/** The write's lease token is stale, or the run is not running. The runner stops. */
export class LeaseLost extends Error {
  constructor() {
    super("lease lost");
  }
}

/**
 * `FOR SHARE` keeps the claim's sweep from taking the run until this transaction ends,
 * so a late write can't land after a takeover.
 */
export async function assertLease(tx: Tx, runId: string, leaseToken: string) {
  const [row] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.leaseToken, leaseToken), eq(runs.state, "running")))
    .for("share");
  if (!row) throw new LeaseLost();
}
