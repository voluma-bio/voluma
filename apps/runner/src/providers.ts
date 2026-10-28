/**
 * The model providers this runner can call: the one list `main.ts` registers with pi-ai and
 * `config.ts` takes the keys to redact from, so a provider added here has its key redacted.
 */
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export const PROVIDERS = {
  anthropic: anthropicProvider,
  meta: metaProvider,
  openai: openaiProvider,
};
