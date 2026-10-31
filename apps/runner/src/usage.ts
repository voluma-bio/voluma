/**
 * What a run has spent since its last acknowledged heartbeat (`Usage` in
 * `@voluma/contracts/runner`): model dollars from Pi's per-reply cost, and the seconds a
 * sandbox was up. A heartbeat takes it and, if the server did not acknowledge, puts it back.
 */
import type { ModelUsage } from "@voluma/contracts/events";
import type { Usage } from "@voluma/contracts/runner";
import { type CacheState, cacheStep } from "@voluma/contracts/spend";

export type ModelRole = "main" | "worker" | "check";

export function usageMeter() {
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
    ModelRole,
    { calls: number; input: number; cacheRead: number; misses: number }
  >();
  // Cache state per thread: a miss is judged against the same thread's previous call.
  const cache = new Map<string, CacheState>();
  return {
    /** One model call's usage: its cost goes to the heartbeat, its tokens and cache miss to the per-role totals. */
    addModelCall(role: ModelRole, threadId: string, used: ModelUsage | undefined) {
      if (!used) return;
      this.addModelCost(used.costUsd);
      const { miss, next } = cacheStep(cache.get(threadId), used);
      cache.set(threadId, next);
      const t = tokens.get(role) ?? { calls: 0, input: 0, cacheRead: 0, misses: 0 };
      t.misses += miss ? 1 : 0;
      t.calls++;
      t.input += used.input;
      t.cacheRead += used.cacheRead;
      tokens.set(role, t);
    },
    /** One line per role: calls, uncached input, cache reads, the share of the prompt read from cache, and the calls that lost the cache. The meter cannot see a compaction (the run view resets its baseline there), so the call after one counts as a miss here; it lives for one claim, so a thread's first call after a restart is never a miss here, unlike the run view. */
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
