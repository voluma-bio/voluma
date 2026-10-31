/**
 * Holds one run's lease (`@voluma/contracts/runner`): a heartbeat every HEARTBEAT_SECONDS
 * carrying the usage since the last acknowledged one. It calls `onStop` for the three ways
 * the run stops that the runner learns here: the server ended it (`stop`), the lease is gone
 * (`LeaseLost`), or no heartbeat has been acknowledged for LEASE_SECONDS - HEARTBEAT_SECONDS,
 * counted from when the last acknowledged one was sent (the claim, before the first). That is
 * before the server's expiry whatever the network delay, and needs no shared clock.
 *
 * Not every missed window is lost contact. If the runner's own event loop was blocked for most of
 * it, the run starved its heartbeats: that stop is `loop-stalled`, which counts as a strike. A
 * heartbeat the API answered with a refusal (a 4xx that a retry cannot fix) fails the run through
 * `onFail`. Only a window in which no call got an answer is a plain `self-stop`.
 */
import { HEARTBEAT_SECONDS, LEASE_SECONDS, type ReleaseReason } from "@voluma/contracts/runner";
import { HttpError } from "@voluma/harness/adapters/http/request";
import type { RunClient } from "@voluma/harness/adapters/http/run-client";
import { LeaseLost } from "@voluma/harness/ports/lease-lost";
import { loopStalledMs } from "./telemetry.ts";
import type { UsageMeter } from "./usage.ts";

export type StopReason =
  | "stop"
  | "lease-lost"
  | Extract<ReleaseReason, "self-stop" | "loop-stalled">;

const SELF_STOP_MS = (LEASE_SECONDS - HEARTBEAT_SECONDS) * 1000;

export function holdLease(options: {
  client: Pick<RunClient, "heartbeat">;
  meter: UsageMeter;
  onStop(reason: StopReason): void;
  /** The API refused a heartbeat for good: the run fails with this message. */
  onFail(message: string): void;
  /** Milliseconds of each acknowledged heartbeat, send to answer (`telemetry.ts`). */
  onRoundTrip(ms: number): void;
  log(line: string): void;
}) {
  const { client, meter, onStop, onFail, onRoundTrip, log } = options;
  let inFlight: Promise<void> | undefined;
  // The window counts from the send of the last acknowledged heartbeat (the claim, before the first).
  const arm = (sentAt: number, stalledAtSend: number) =>
    setTimeout(
      () =>
        onStop(loopStalledMs() - stalledAtSend > SELF_STOP_MS / 2 ? "loop-stalled" : "self-stop"),
      sentAt + SELF_STOP_MS - Date.now(),
    );
  let deadline = arm(Date.now(), loopStalledMs());

  async function beat(): Promise<void> {
    const sentAt = Date.now();
    const stalledAtSend = loopStalledMs();
    const usage = meter.take();
    try {
      const { stop } = await client.heartbeat(usage);
      onRoundTrip(Date.now() - sentAt);
      clearTimeout(deadline);
      deadline = arm(sentAt, stalledAtSend);
      if (stop) onStop("stop");
    } catch (error) {
      meter.restore(usage);
      // A lost lease already stopped the run: the client reports it (`onLeaseLost`).
      if (error instanceof HttpError && error.status < 500) {
        // Resending the same body cannot succeed (`request.ts` does not retry it): stopping and
        // resuming would loop on it, so the run fails with the API's answer.
        onFail(`The server refused the runner's heartbeat: ${error.message}`);
      } else if (!(error instanceof LeaseLost)) {
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
