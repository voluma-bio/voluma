/**
 * What a run has spent since its last acknowledged heartbeat (`Usage` in
 * `@voluma/contracts/runner`): model dollars from Pi's per-reply cost, and the seconds a
 * sandbox was up. A heartbeat takes it and, if the server did not acknowledge, puts it back.
 *
 * It is also the run's one stop check: `addModelCall` returns why the run must stop, if it must,
 * and the runner fails the run with a `RunStopped` (never retried: a retry spends again).
 */
import type { ModelUsage } from "@voluma/contracts/events";
import type { Usage } from "@voluma/contracts/runner";
import {
  type CacheState,
  cacheStep,
  isToolsChangedNotice,
  missKind,
} from "@voluma/contracts/spend";

/** Why a run must stop: past its budget, or a thread whose prompt cache keeps breaking. */
export type StopReason = { kind: "budget" | "cache"; message: string };

/** The error a stop check fails the run with. Final: nothing retries or resumes it. */
export class RunStopped extends Error {
  constructor(readonly reason: StopReason) {
    super(reason.message);
    this.name = "RunStopped";
  }
}

export type StopLimits = {
  runId: string;
  /** The run's cap in model dollars: the study budget, at most the runner's ceiling. */
  capUsd: number;
  /** What earlier claims of the run spent (`run.usage`), so a resumed run gets no fresh budget. */
  priorUsd: number;
  /** Unexpected cache misses in a row on one thread that stop the run. */
  cacheMissLimit: number;
};

/** For a meter that only times sandboxes (`dev-sandbox.ts`): nothing stops it. */
export const noLimits: StopLimits = {
  runId: "",
  capUsd: Number.POSITIVE_INFINITY,
  priorUsd: 0,
  cacheMissLimit: Number.POSITIVE_INFINITY,
};

export function usageMeter(limits: StopLimits) {
  let modelCostUsd = 0;
  let sandboxSeconds = 0;
  // Sandbox seconds are summed over the sandboxes (each thread holds one): `settle` books
  // the time since the last change at the count then.
  let up = 0;
  let settledAt = Date.now();
  const settle = () => {
    const now = Date.now();
    sandboxSeconds += (up * (now - settledAt)) / 1000;
    settledAt = now;
  };
  // Everything accumulated over the run, for the log; `take` only drains the heartbeat's share.
  let totalCostUsd = 0;
  const tokens = new Map<
    string,
    { calls: number; input: number; cacheRead: number; misses: number }
  >();
  // Cache state per thread: a miss is judged against the same thread's previous call.
  const cache = new Map<string, CacheState>();
  // Per thread: unexpected misses in a row, and whether a "Tools changed" notice came since its last call.
  const streaks = new Map<string, number>();
  const toolsChanged = new Set<string>();
  return {
    /**
     * One model call's usage: its cost goes to the heartbeat, its tokens and cache miss to the
     * per-role totals. Returns why the run must stop, or undefined.
     */
    addModelCall(
      role: string,
      threadId: string,
      used: ModelUsage | undefined,
    ): StopReason | undefined {
      if (!used) return;
      this.addModelCost(used.costUsd);
      const { miss, next } = cacheStep(cache.get(threadId), used);
      cache.set(threadId, next);
      const kind = missKind(miss, toolsChanged.has(threadId));
      if (miss !== undefined) toolsChanged.delete(threadId);
      const streak =
        kind === "unexpected"
          ? (streaks.get(threadId) ?? 0) + 1
          : miss === undefined
            ? (streaks.get(threadId) ?? 0)
            : 0;
      streaks.set(threadId, streak);
      const t = tokens.get(role) ?? { calls: 0, input: 0, cacheRead: 0, misses: 0 };
      t.misses += miss ? 1 : 0;
      t.calls++;
      t.input += used.input;
      t.cacheRead += used.cacheRead;
      tokens.set(role, t);
      const spent = limits.priorUsd + totalCostUsd;
      if (spent > limits.capUsd)
        return {
          kind: "budget",
          message: `budget exceeded: run ${limits.runId} spent $${spent.toFixed(2)} on model calls, over its $${limits.capUsd} cap`,
        };
      if (streak >= limits.cacheMissLimit)
        return {
          kind: "cache",
          message: `cache broken: thread ${threadId} (${role}) of run ${limits.runId} missed the prompt cache unexpectedly on ${streak} model calls in a row`,
        };
    },
    /**
     * A message the thread recorded: a compaction summary starts a new cache baseline (as in
     * `spend`), and a "Tools changed" notice makes the thread's next miss expected.
     */
    addMessage(threadId: string, m: { role: string; text: string; compaction?: true }) {
      if (m.compaction) {
        cache.delete(threadId);
        streaks.delete(threadId);
      } else if (isToolsChangedNotice(m)) toolsChanged.add(threadId);
    },
    /** One line per role: calls, uncached input, cache reads, the share of the prompt read from cache, and the calls that lost the cache. The meter learns of a compaction only when its summary is recorded (`addMessage`), after the summary's own calls; it lives for one claim, so a thread's first call after a restart is never a miss here, unlike the run view. */
    cacheSummary(): string[] {
      return [...tokens].map(([role, t]) => {
        const share = t.input + t.cacheRead > 0 ? t.cacheRead / (t.input + t.cacheRead) : 0;
        return `${role}: ${t.calls} calls, input ${t.input}, cacheRead ${t.cacheRead}, cache hit ${(share * 100).toFixed(1)}%, cache misses ${t.misses}`;
      });
    },
    addModelCost(usd: number) {
      modelCostUsd += usd;
      totalCostUsd += usd;
    },
    totalModelCostUsd: () => totalCostUsd,
    sandboxUp() {
      settle();
      up++;
    },
    sandboxDown() {
      if (up === 0) return;
      settle();
      up--;
    },
    take(): Usage {
      settle();
      const taken = { modelCostUsd, sandboxSeconds };
      modelCostUsd = 0;
      sandboxSeconds = 0;
      return taken;
    },
    restore(usage: Usage) {
      modelCostUsd += usage.modelCostUsd;
      sandboxSeconds += usage.sandboxSeconds;
    },
  };
}
export type UsageMeter = ReturnType<typeof usageMeter>;
