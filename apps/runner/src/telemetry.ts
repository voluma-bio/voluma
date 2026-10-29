/**
 * What the runner process knows about itself, for diagnosing a lost run from its log: which run
 * an unhandled error belongs to, how late the event loop runs, how long heartbeats take, and
 * which tools were in flight when the loop stalled. Every line starts with `telemetry` and is
 * documented in `.context/CONTEXT.md` ("Telemetry").
 *
 * A run's work runs inside `runScope` (AsyncLocalStorage), so an error that nobody caught is
 * tied to its run by the async context it was raised in, not by guessing from its message:
 * the run fails with that error and the process and its other runs go on.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export interface RunScope {
  runId: string;
  /** The run's redacting log: the only way an error that mentions its keys may reach the console. */
  log(line: string): void;
  /** Tool calls emitted and not yet resulted, by toolCallId -> "thread tool". */
  inFlight: Map<string, string>;
  /**
   * Fails the run with this error; set once the run can report. Returns false when the run's
   * report is already fixed, so the error changes nothing.
   */
  fail?(error: unknown): boolean;
}
const runScope = new AsyncLocalStorage<RunScope>();
const scopes = new Set<RunScope>();

/** Runs the body inside the scope; the scope, and so its in-flight calls, ends when the body settles. */
export function inRunScope<T>(scope: RunScope, body: () => Promise<T>): Promise<T> {
  scopes.add(scope);
  return runScope.run(scope, body).finally(() => scopes.delete(scope));
}

/** The calls in flight across live runs, as "run thread tool". */
export function inFlightCalls(): string[] {
  return [...scopes].flatMap((s) => [...s.inFlight.values()].map((label) => `${s.runId} ${label}`));
}

const REPORT_EVERY_MS = 60_000;
const SAMPLE_MS = 100;
const BLOCK_MS = 1_000;
const ms = (ns: number) => Math.round(ns / 1e6);

let roundTrips: number[] = [];

export function heartbeatRoundTrip(millis: number) {
  roundTrips.push(millis);
}

/** Installs the process handlers and the timers; call once, at startup. */
export function startTelemetry(log: (line: string) => void) {
  // Inside an uncaughtException handler a throw kills the process: never throw here.
  const describe = (reason: unknown) => {
    try {
      return reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    } catch {
      return "(unprintable error)";
    }
  };
  const onError = (kind: string) => (reason: unknown) => {
    const scope = runScope.getStore();
    if (!scope) {
      log(`telemetry ${kind} outside any run (process kept alive): ${describe(reason)}`);
      return;
    }
    const failed = scope.fail?.(reason) ?? false;
    scope.log(
      `telemetry ${kind} ${failed ? "in this run, failing it" : "after its report was fixed"}: ${describe(reason)}`,
    );
  };
  process.on("unhandledRejection", onError("unhandledRejection"));
  process.on("uncaughtException", onError("uncaughtException"));

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  setInterval(() => {
    log(
      `telemetry loop-delay p99=${ms(delay.percentile(99))}ms max=${ms(delay.max)}ms (last ${REPORT_EVERY_MS / 1000}s)`,
    );
    delay.reset();
    const sorted = roundTrips.sort((a, b) => a - b);
    roundTrips = [];
    if (sorted.length)
      log(
        `telemetry heartbeat-rtt p50=${sorted[Math.floor((sorted.length - 1) / 2)]}ms max=${sorted.at(-1)}ms n=${sorted.length} (last ${REPORT_EVERY_MS / 1000}s)`,
      );
  }, REPORT_EVERY_MS).unref();

  // A timer that fires much later than asked means something held the loop that long.
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const late = now - last - SAMPLE_MS;
    last = now;
    if (late > BLOCK_MS)
      log(
        `telemetry loop-block ${Math.round(late)}ms; in flight: ${inFlightCalls().join("; ") || "no tool"}`,
      );
  }, SAMPLE_MS).unref();
}
