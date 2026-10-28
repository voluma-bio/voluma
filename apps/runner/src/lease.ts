/**
 * Holds one run's lease (`@voluma/contracts/runner`): a heartbeat every HEARTBEAT_SECONDS
 * carrying the usage since the last acknowledged one. It calls `onStop` for the three ways
 * the run stops that the runner learns here: the server ended it (`stop`), the lease is gone
 * (`LeaseLost`), or no heartbeat has been acknowledged for LEASE_SECONDS - HEARTBEAT_SECONDS,
 * counted from when the last acknowledged one was sent (the claim, before the first). That is
 * before the server's expiry whatever the network delay, and needs no shared clock.
 */
import { HEARTBEAT_SECONDS, LEASE_SECONDS, type ReportRequest } from "@voluma/contracts/runner";
import type { handOff } from "@voluma/harness/adapters/http/hand-off";
import { LeaseLost } from "@voluma/harness/ports/lease-lost";
import type { UsageMeter } from "./usage.ts";

export type StopReason = "stop" | "lease-lost" | "self-stop";

const SELF_STOP_MS = (LEASE_SECONDS - HEARTBEAT_SECONDS) * 1000;

export function holdLease(options: {
  api: ReturnType<typeof handOff>;
  runId: string;
  leaseToken: string;
  meter: UsageMeter;
  onStop(reason: StopReason): void;
  log(line: string): void;
}) {
  const { api, runId, leaseToken, meter, onStop, log } = options;
  let ended = false;
  let inFlight: Promise<void> | undefined;
  let deadline = setTimeout(() => onStop("self-stop"), SELF_STOP_MS);

  async function beat(): Promise<void> {
    const sentAt = Date.now();
    const usage = meter.take();
    try {
      const { stop } = await api.heartbeat(runId, leaseToken, usage);
      clearTimeout(deadline);
      if (!ended)
        deadline = setTimeout(() => onStop("self-stop"), sentAt + SELF_STOP_MS - Date.now());
      if (stop) onStop("stop");
    } catch (error) {
      meter.restore(usage);
      if (error instanceof LeaseLost) onStop("lease-lost");
      else log(`heartbeat failed, will retry: ${error instanceof Error ? error.message : error}`);
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
      ended = true;
      clearTimeout(deadline);
    },
  };
}

/** Which report a stop reason, a clean end or a failure becomes; undefined: say nothing more. */
export function reportFor(
  stopped: StopReason | "shutdown" | undefined,
  result: { error?: string },
): ReportRequest["report"] | undefined {
  if (stopped === "stop" || stopped === "lease-lost") return undefined;
  if (stopped === "self-stop" || stopped === "shutdown") return { kind: "released" };
  return result.error === undefined
    ? { kind: "ended", outcome: "completed" }
    : { kind: "ended", outcome: "failed", error: result.error };
}
