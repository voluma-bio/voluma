import { describe, expect, it } from "vitest";
import { providerFailure } from "./provider-error.ts";

// The texts each provider path produces. A drift here is silent: a run fails when it should have
// resumed, or resumes forever.
describe("providerFailure", () => {
  it.each([
    // Before the reply: Pi has retried and gave up.
    ["Meta API error (503): upstream down", false, "transient"],
    ["Request timed out.", false, "transient"],
    ["Connection error.", false, "transient"],
    ['529 {"type":"error","error":{"type":"overloaded_error"}}', false, "transient"],
    [
      "Server requested 45s retry delay (max: 30s). 429 Rate limit reached for requests",
      false,
      "transient",
    ],
    [
      'Server requested 45s retry delay (max: 30s). 429 {"error":{"type":"rate_limit_error"}}',
      false,
      "transient",
    ],
    // Fatal either way.
    ["Meta API error (401): bad key", false, "fatal"],
    ["Meta API error (429): insufficient_quota", false, "fatal"],
    ["Server requested 45s retry delay (max: 30s). 429 insufficient_quota", false, "fatal"],
    ["Meta API error (404): model not found", true, "fatal"],
    // After the reply started: whatever the provider calls it.
    ["Anthropic stream ended before message_stop", true, "interrupted"],
    [
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      true,
      "interrupted",
    ],
    ["OpenAI Responses stream ended without a stop reason", true, "interrupted"],
    ["terminated", true, "interrupted"],
    ["Error Code server_error: The server had an error", true, "interrupted"],
    ["server_error: The server had an error while processing your request", true, "interrupted"],
    // Not the provider's.
    ["Meta API error (400): context_length_exceeded", false, undefined],
    ["Meta API error (400): context_length_exceeded", true, undefined],
    ["something else broke", false, undefined],
  ] as const)("%s (reply started: %s) is %s", (text, replyStarted, expected) => {
    expect(providerFailure(text, replyStarted)).toBe(expected);
  });
});
