/**
 * What a run has spent since its last acknowledged heartbeat (`Usage` in
 * `@voluma/contracts/runner`): model dollars from Pi's per-reply cost, and the seconds a
 * sandbox was up. A heartbeat takes it and, if the server did not acknowledge, puts it back.
 */
import type { Usage } from "@voluma/contracts/runner";

export function usageMeter() {
  let modelCostUsd = 0;
  let sandboxSeconds = 0;
  let upSince: number | undefined;
  // Everything accumulated over the run, for the log; `take` only drains the heartbeat's share.
  let totalCostUsd = 0;
  return {
    addModelCost(usd: number) {
      modelCostUsd += usd;
      totalCostUsd += usd;
    },
    totalModelCostUsd: () => totalCostUsd,
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
