/**
 * Holds one run's lease (`@voluma/contracts/runner`): a heartbeat every HEARTBEAT_SECONDS
 * carrying the usage since the last acknowledged one. It calls `onStop` for the three ways
 * the run stops that the runner learns here: the server ended it (`stop`), the lease is gone
 * (`LeaseLost`), or no heartbeat has been acknowledged for LEASE_SECONDS - HEARTBEAT_SECONDS,
 * counted from when the last acknowledged one was sent (the claim, before the first). That is
 * before the server's expiry whatever the network delay, and needs no shared clock.
 */
import { HEARTBEAT_SECONDS, LEASE_SECONDS } from "@voluma/contracts/runner";
import type { RunClient } from "@voluma/harness/adapters/http/run-client";
import { LeaseLost } from "@voluma/harness/ports/lease-lost";
import type { UsageMeter } from "./usage.ts";

export type StopReason = "stop" | "lease-lost" | "self-stop";

const SELF_STOP_MS = (LEASE_SECONDS - HEARTBEAT_SECONDS) * 1000;

export function holdLease(options: {
  client: Pick<RunClient, "heartbeat">;
  meter: UsageMeter;
  onStop(reason: StopReason): void;
  /** The run's total spend as of an acknowledged heartbeat (model and gateway calls, all claims). */
  onSpent(usd: number): void;
  log(line: string): void;
}) {
  const { client, meter, onStop, onSpent, log } = options;
  let inFlight: Promise<void> | undefined;
  let deadline = setTimeout(() => onStop("self-stop"), SELF_STOP_MS);

  async function beat(): Promise<void> {
    const sentAt = Date.now();
    const usage = meter.take();
    try {
      const { stop, spentUsd } = await client.heartbeat(usage);
      if (spentUsd !== undefined) onSpent(spentUsd);
      clearTimeout(deadline);
      deadline = setTimeout(() => onStop("self-stop"), sentAt + SELF_STOP_MS - Date.now());
      if (stop) onStop("stop");
    } catch (error) {
      meter.restore(usage);
      // A lost lease already stopped the run: the client reports it (`onLeaseLost`).
      if (!(error instanceof LeaseLost)) {
        log(`heartbeat failed, will retry: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  const timer = setInterval(() => {
    inFlight ??= beat().finally(() => {
      inFlight = undefined;
    });
  }, HEARTBEAT_SECONDS * 1000);

  return {
    /** Stops the timers; with `finalUsage`, first sends the usage since the last heartbeat. */
    async end(finalUsage: boolean) {
      clearInterval(timer);
      await inFlight;
      if (finalUsage) await beat();
      clearTimeout(deadline);
    },
  };
}
