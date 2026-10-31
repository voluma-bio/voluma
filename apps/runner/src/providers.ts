/**
 * The model providers this runner can call: the one list `main.ts` registers with pi-ai and
 * `config.ts` takes the keys to redact from, so a provider added here has its key redacted. A
 * provider that serves a model with its own documented limits pi-ai lacks (e.g. Meta's image count
 * through a gateway) needs an entry in `PROVIDER_IMAGES_PER_REQUEST` (harness `compaction.ts`).
 */
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export const PROVIDERS = {
  anthropic: anthropicProvider,
  deepseek: deepseekProvider,
  meta: metaProvider,
  openai: openaiProvider,
};
