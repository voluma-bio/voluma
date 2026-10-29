/**
 * What a run has spent since its last acknowledged heartbeat (`Usage` in
 * `@voluma/contracts/runner`): model dollars from Pi's per-reply cost, and the seconds a
 * sandbox was up. A heartbeat takes it and, if the server did not acknowledge, puts it back.
 */
import type { ModelUsage } from "@voluma/contracts/events";
import type { Usage } from "@voluma/contracts/runner";

export type ModelRole = "main" | "worker" | "check";

/** `onCost` is called after each model cost is added. */
export function usageMeter(onCost?: () => void) {
  let modelCostUsd = 0;
  let sandboxSeconds = 0;
  let upSince: number | undefined;
  // Everything accumulated over the run, for the log; `take` only drains the heartbeat's share.
  let totalCostUsd = 0;
  const tokens = new Map<ModelRole, { calls: number; input: number; cacheRead: number }>();
  return {
    /** One model call's usage: its cost goes to the heartbeat, its tokens to the per-role totals. */
    addModelCall(role: ModelRole, used: ModelUsage | undefined) {
      if (!used) return;
      this.addModelCost(used.costUsd);
      const t = tokens.get(role) ?? { calls: 0, input: 0, cacheRead: 0 };
      t.calls++;
      t.input += used.input;
      t.cacheRead += used.cacheRead;
      tokens.set(role, t);
    },
    /** One line per role: calls, uncached input, cache reads, and the share of the prompt read from cache. */
    cacheSummary(): string[] {
      return [...tokens].map(([role, t]) => {
        const share = t.input + t.cacheRead > 0 ? t.cacheRead / (t.input + t.cacheRead) : 0;
        return `${role}: ${t.calls} calls, input ${t.input}, cacheRead ${t.cacheRead}, cache hit ${(share * 100).toFixed(1)}%`;
      });
    },
    addModelCost(usd: number) {
      modelCostUsd += usd;
      totalCostUsd += usd;
      onCost?.();
    },
    totalModelCostUsd: () => totalCostUsd,
    /** Model dollars the server has not yet acknowledged in a heartbeat. */
    pendingModelCostUsd: () => modelCostUsd,
    sandboxUp() {
      upSince ??= Date.now();
    },
    sandboxDown() {
      if (upSince === undefined) return;
      sandboxSeconds += (Date.now() - upSince) / 1000;
      upSince = undefined;
    },
    take(): Usage {
      const now = Date.now();
      let seconds = sandboxSeconds;
      if (upSince !== undefined) {
        seconds += (now - upSince) / 1000;
        upSince = now;
      }
      const taken = { modelCostUsd, sandboxSeconds: seconds };
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
