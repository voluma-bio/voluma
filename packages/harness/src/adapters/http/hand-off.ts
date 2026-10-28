/**
 * The runner's side of the hand-off routes that are not about one thread's records:
 * claim, heartbeat and report (`@voluma/contracts/runner`). A stale lease on heartbeat or
 * report is `LeaseLost`.
 */
import {
  type Claim,
  claimResponseSchema,
  type HeartbeatResponse,
  heartbeatResponseSchema,
  type ReportRequest,
  type Usage,
} from "@voluma/contracts/runner";
import { LeaseLost } from "../../ports/lease-lost";
import { type Endpoint, HttpError, postJson } from "./request";

const REPORT_BUDGET_MS = 60_000;

export function handOff(endpoint: Endpoint, runnerId: string) {
  const runPath = (runId: string) => `/api/run/ingest/runs/${encodeURIComponent(runId)}`;
  return {
    /** The next run this runner may start, leased to it; null when there is none. */
    async claim(): Promise<Claim | null> {
      const response = await postJson(endpoint, "/api/run/ingest/claim", { runnerId });
      return claimResponseSchema.parse(await response.json()).claim;
    },

    /** One attempt: the caller keeps the usage and resends it if this throws. */
    async heartbeat(runId: string, leaseToken: string, usage: Usage): Promise<HeartbeatResponse> {
      const response = await postJson(
        endpoint,
        `${runPath(runId)}/heartbeat`,
        { usage },
        { leaseToken },
      );
      return heartbeatResponseSchema.parse(await response.json());
    },

    /**
     * Ends or releases the run. A 409 means the server ended the run first or the lease is
     * no longer ours: nothing more to say, so it returns. A network failure is retried for a
     * minute; the lease expires on its own after that.
     */
    async report(runId: string, leaseToken: string, report: ReportRequest["report"]) {
      try {
        await postJson(
          endpoint,
          `${runPath(runId)}/report`,
          { report },
          { leaseToken, retryForMs: REPORT_BUDGET_MS },
        );
      } catch (error) {
        if (error instanceof LeaseLost || (error instanceof HttpError && error.status === 409)) {
          return;
        }
        throw error;
      }
    },
  };
}
