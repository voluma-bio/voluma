/**
 * Holds one run's lease (`@voluma/contracts/runner`): a heartbeat every HEARTBEAT_SECONDS
 * carrying the usage since the last acknowledged one. It calls `onStop` for the three ways
 * the run stops that the runner learns here: the server ended it (`stop`), the lease is gone
 * (`LeaseLost`), or no heartbeat has been acknowledged for SELF_STOP_SECONDS,
 * counted from when the last acknowledged one was sent (the claim, before the first). That is
 * before the server's expiry whatever the network delay, and needs no shared clock.
 *
 * Not every missed window is lost contact. If the runner's own event loop was blocked for most of
 * it while this was the only live run, the run starved its heartbeats: that stop is
 * `loop-stalled`, which counts as a strike. (With two runs live the block can't be pinned on
 * either, so each reports `self-stop`.) A heartbeat the API answered with a refusal (a 4xx that a
 * retry cannot fix) stops the run as `refused`, which counts too: skew that clears after a deploy
 * costs one strike, a body that is refused every time ends the run at the limit. Only a window in
 * which no call got an answer is a plain `self-stop`.
 */
import { HEARTBEAT_SECONDS, type ReleaseReason, SELF_STOP_SECONDS } from "@voluma/contracts/runner";
import { HttpError } from "@voluma/harness/adapters/http/request";
import type { RunClient } from "@voluma/harness/adapters/http/run-client";
import { LeaseLost } from "@voluma/harness/ports/lease-lost";
import { soloStalledMs } from "./telemetry.ts";
import type { UsageMeter } from "./usage.ts";

export type StopReason =
  | "stop"
  | "lease-lost"
  | Extract<ReleaseReason, "self-stop" | "loop-stalled" | "refused">;

const SELF_STOP_MS = SELF_STOP_SECONDS * 1000;

export function holdLease(options: {
  client: Pick<RunClient, "heartbeat">;
  meter: UsageMeter;
  onStop(reason: StopReason): void;
  /** Milliseconds of each acknowledged heartbeat, send to answer (`telemetry.ts`). */
  onRoundTrip(ms: number): void;
  log(line: string): void;
}) {
  const { client, meter, onStop, onRoundTrip, log } = options;
  let inFlight: Promise<void> | undefined;
  // The window counts from the send of the last acknowledged heartbeat (the claim, before the first).
  const arm = (sentAt: number, stalledAtSend: number) =>
    setTimeout(
      () =>
        onStop(soloStalledMs() - stalledAtSend > SELF_STOP_MS / 2 ? "loop-stalled" : "self-stop"),
      sentAt + SELF_STOP_MS - Date.now(),
    );
  let deadline = arm(Date.now(), soloStalledMs());

  async function beat(): Promise<void> {
    const sentAt = Date.now();
    const stalledAtSend = soloStalledMs();
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
        // Resending the same body cannot succeed (`request.ts` does not retry it). Release the
        // run; the next claim starts a fresh usage meter, so it does not carry the refused body.
        log(`heartbeat refused: ${error.message}`);
        onStop("refused");
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
    /** Stops the timers at once, so a run being closed can't also stop with a late `self-stop`. */
    halt() {
      clearInterval(timer);
      clearTimeout(deadline);
    },
    /** Sends the usage since the last acknowledged heartbeat, after the one in flight. */
    async sendFinalUsage() {
      await inFlight;
      await beat();
      clearTimeout(deadline);
    },
  };
}
