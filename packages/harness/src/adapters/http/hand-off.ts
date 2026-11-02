/**
 * The runner's one call before it holds a run: claim (`@voluma/contracts/runner`). Everything
 * after is run-scoped and lease-carrying: `run-client.ts`.
 */
import type { Harness } from "@voluma/contracts/ids";
import { type Claim, claimResponseSchema } from "@voluma/contracts/runner";
import { type Endpoint, postJson } from "./request";

/** The next run of one of `harnesses` this runner may start, leased to it; null when there is none. */
export async function claimRun(
  endpoint: Endpoint,
  runnerId: string,
  harnesses: readonly Harness[],
): Promise<Claim | null> {
  const response = await postJson(endpoint, "/api/run/ingest/claim", { runnerId, harnesses });
  return claimResponseSchema.parse(await response.json()).claim;
}
