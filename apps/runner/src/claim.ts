/**
 * The hand-started CLI as a claimer (`@voluma/contracts/runner`): it takes the next queued
 * run, keeps the lease with heartbeats while the thread runs, and ends the run. A run must
 * have been started first (the browser's `POST /api/run/runs`). Usage is not sent, so the
 * org's dollar ceiling does not see this CLI's spend.
 */
import {
  type Claim,
  claimResponseSchema,
  HEARTBEAT_SECONDS,
  heartbeatResponseSchema,
  LEASE_TOKEN_HEADER,
  type ReportRequest,
} from "@voluma/contracts/runner";

export interface Api {
  baseUrl: string;
  token: string;
}

async function post(api: Api, path: string, body: unknown, leaseToken?: string) {
  const response = await fetch(new URL(`/api/run/ingest${path}`, api.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${api.token}`,
      "content-type": "application/json",
      ...(leaseToken && { [LEASE_TOKEN_HEADER]: leaseToken }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}

/** The next queued run, leased to this process. */
export async function claimNext(api: Api, runnerId: string): Promise<Claim> {
  const { claim } = claimResponseSchema.parse(
    await (await post(api, "/claim", { runnerId })).json(),
  );
  if (!claim) throw new Error("no queued run to claim: start one first");
  return claim;
}

/** Heartbeats the lease until `end` is called; `onStop` runs if the server ended the run or took the lease. */
export function holdLease(api: Api, runId: string, leaseToken: string, onStop: () => void) {
  const path = `/runs/${encodeURIComponent(runId)}`;
  const timer = setInterval(async () => {
    try {
      const response = await post(
        api,
        `${path}/heartbeat`,
        { usage: { modelCostUsd: 0, sandboxSeconds: 0 } },
        leaseToken,
      );
      if (heartbeatResponseSchema.parse(await response.json()).stop) onStop();
    } catch (error) {
      console.error(`heartbeat: ${error instanceof Error ? error.message : error}`);
      onStop();
    }
  }, HEARTBEAT_SECONDS * 1000);
  return async (report: ReportRequest["report"]) => {
    clearInterval(timer);
    // A 409 here means the server ended the run already (cancelled) or took the lease.
    await post(api, `${path}/report`, { report }, leaseToken).catch((error) =>
      console.error(`report: ${error instanceof Error ? error.message : error}`),
    );
  };
}
