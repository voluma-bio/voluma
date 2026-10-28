/**
 * A model reply's usage as the event log records it (`modelUsageSchema`); undefined when the
 * provider returned none. Telemetry must never invalidate the event that carries it (the
 * recorder drops an event the schema rejects), and some Pi adapters can report a negative
 * input or a NaN cost, so counts are clamped to whole non-negative numbers here.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelUsage } from "@voluma/contracts/events";

const count = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

export function usageOf(reply: AssistantMessage): ModelUsage | undefined {
  const u = reply.usage;
  if (!u) return undefined;
  return {
    input: count(u.input),
    output: count(u.output),
    cacheRead: count(u.cacheRead),
    cacheWrite: count(u.cacheWrite),
    ...(u.reasoning !== undefined && { reasoning: count(u.reasoning) }),
    costUsd: Number.isFinite(u.cost.total) ? Math.max(0, u.cost.total) : 0,
  };
}
