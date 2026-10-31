import { describe, expect, it } from "vitest";
import { providerFailure } from "./provider-error.ts";

// The texts each provider path produces. A drift here is silent: a run fails when it should have
// resumed, or a model's refusal reads as a provider failure.
describe("providerFailure", () => {
  it.each([
    ["Meta API error (503): upstream down", "transient"],
    ["Request timed out.", "transient"],
    ["Connection error.", "transient"],
    ['529 {"type":"error","error":{"type":"overloaded_error"}}', "transient"],
    [
      "Server requested 45s retry delay (max: 30s). 429 Rate limit reached for requests",
      "transient",
    ],
    [
      'Server requested 45s retry delay (max: 30s). 429 {"error":{"type":"rate_limit_error"}}',
      "transient",
    ],
    ["Meta API error (401): bad key", "fatal"],
    ["Meta API error (404): model not found", "fatal"],
    ["Meta API error (429): insufficient_quota", "fatal"],
    ["Server requested 45s retry delay (max: 30s). 429 insufficient_quota", "fatal"],
    // Stream errors carry no status, and some read like connection errors: whether they came after
    // the reply started is the thread's record (`interrupted`), which overrides these but fatal.
    ["Anthropic stream ended before message_stop", "transient"],
    ["terminated", undefined],
    ["server_error: The server had an error while processing your request", undefined],
    // The model's own stops and the thread's own failures are not the provider's.
    ["Meta API error (400): context_length_exceeded", undefined],
    ["refusal: the model declined to continue", undefined],
    ["the model hit its output limit (stop reason length)", undefined],
    ["the thread ended without a reply", undefined],
    ["unexpected stop reason toolUse", undefined],
    ["storing the thread's history failed, so it stopped: Error: boom", undefined],
  ] as const)("%s is %s", (text, expected) => {
    expect(providerFailure(text)).toBe(expected);
  });
});
