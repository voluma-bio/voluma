/**
 * What a call costs, in one place for the gateway (and, once the runner's model calls move
 * onto it, the runner). Model prices come from Pi's model catalog, in dollars per million
 * tokens; a model Pi has no price for is refused. SAM is priced by frame, not by token.
 */
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { Provider } from "./token";

/** Meta bills $0.20 per 1,000 video frames, at least 50 per request, at most 15,000 frames. */
export const SAM_MODEL = "sam-3.1";
export const SAM_USD_PER_FRAME = 0.0002;
export const SAM_MIN_FRAMES = 50;
export const SAM_MAX_FRAMES = 15_000;

let catalog: ReturnType<typeof createModels> | undefined;
function models() {
  if (!catalog) {
    catalog = createModels();
    for (const provider of [anthropicProvider, metaProvider, openaiProvider]) {
      catalog.setProvider(provider());
    }
  }
  return catalog;
}

/** What a call reported: tokens as the provider counts them, or SAM's frames. */
export type Observed = {
  inputTokens?: number;
  outputTokens?: number;
  /** Anthropic: `cache_read_input_tokens`; Responses: `input_tokens_details.cached_tokens`. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  frames?: number;
};

type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Priced = Rates & { tiers?: (Rates & { inputTokensAbove: number })[] };

function priceOf(provider: Provider, id: string): { cost: Priced; maxTokens: number } | undefined {
  const model = models().getModel(provider, id);
  return model && { cost: model.cost, maxTokens: model.maxTokens };
}

/** Whether a model call to this id has a price; SAM is priced by frame. */
export const hasPrice = (provider: Provider, id: string) =>
  (provider === "meta" && id === SAM_MODEL) || priceOf(provider, id) !== undefined;

/**
 * Dollars held when a call is admitted. SAM: the 15,000-frame maximum, which the caller cannot
 * lower. A model call: `maxTokens` (the request's, else the model's maximum) at the output price
 * of the most expensive tier. Null: the model has no price.
 */
export function reservationUsd(
  provider: Provider,
  model: string,
  maxTokens: number | undefined,
): number | null {
  if (provider === "meta" && model === SAM_MODEL) return SAM_MAX_FRAMES * SAM_USD_PER_FRAME;
  const priced = priceOf(provider, model);
  if (!priced) return null;
  const output = Math.max(priced.cost.output, ...(priced.cost.tiers ?? []).map((t) => t.output));
  return ((maxTokens ?? priced.maxTokens) * output) / 1e6;
}

/** What the call cost, from what it reported; null when it reported nothing to price. */
export function costUsd(provider: Provider, model: string, seen: Observed): number | null {
  if (seen.frames !== undefined) {
    return Math.max(seen.frames, SAM_MIN_FRAMES) * SAM_USD_PER_FRAME;
  }
  const priced = priceOf(provider, model);
  if (!priced || seen.inputTokens === undefined || seen.outputTokens === undefined) return null;
  const cacheRead = seen.cacheReadTokens ?? 0;
  const cacheWrite = seen.cacheWriteTokens ?? 0;
  // Anthropic's input count leaves the cache out; Responses' includes the cached part.
  const uncached =
    provider === "anthropic" ? seen.inputTokens : Math.max(0, seen.inputTokens - cacheRead);
  const promptTokens = uncached + cacheRead + cacheWrite;
  const tier = (priced.cost.tiers ?? []).filter((t) => promptTokens > t.inputTokensAbove).at(-1);
  const rate = tier ?? priced.cost;
  return (
    (uncached * rate.input +
      cacheRead * rate.cacheRead +
      cacheWrite * rate.cacheWrite +
      seen.outputTokens * rate.output) /
    1e6
  );
}
