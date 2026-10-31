import { createModels } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { PROVIDERS } from "./providers.ts";
import { assertThinking } from "./thinking.ts";

const models = createModels();
for (const provider of Object.values(PROVIDERS)) models.setProvider(provider());
const wonder = models.getModel("meta", "muse-wonder-1.0");
const spark = models.getModel("meta", "muse-spark-1.3");
const opus = models.getModel("anthropic", "claude-opus-4-6");
if (!wonder || !spark || !opus) throw new Error("thinking test models missing from the catalog");

// Pi Agent sends no requested effort for `off`, even when the model can't disable reasoning.
test("unset and off send no level; unsupported non-off levels still fail", () => {
  expect(() => assertThinking(undefined, [wonder, spark], "worker")).not.toThrow();
  expect(() => assertThinking("off", [wonder, spark], "worker")).not.toThrow();
  expect(() => assertThinking("high", [wonder, spark], "worker")).not.toThrow();
  expect(() => assertThinking("xhigh", [wonder], "RUNNER_THINKING")).not.toThrow();
  expect(() => assertThinking("xhigh", [opus], "worker")).toThrow(/not one anthropic\/claude-opus/);
  expect(() => assertThinking("xhigh", [wonder, opus], "RUNNER_THINKING")).toThrow(
    /not one anthropic\/claude-opus/,
  );
});
