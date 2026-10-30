import { createModels } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { PROVIDERS } from "./providers.ts";
import { assertThinking } from "./thinking.ts";

const models = createModels();
for (const provider of Object.values(PROVIDERS)) models.setProvider(provider());
const wonder = models.getModel("meta", "muse-wonder-1.0");
if (!wonder) throw new Error("muse-wonder-1.0 missing from the catalog");

// Every role file uses a Muse model, which takes no `off`: an unset level must not be checked.
test("an unset level checks nothing; an explicit unsupported one fails", () => {
  expect(() => assertThinking(undefined, [wonder], "worker")).not.toThrow();
  expect(() => assertThinking("high", [wonder], "worker")).not.toThrow();
  expect(() => assertThinking("off", [wonder], "worker")).toThrow(/not one meta\/muse-wonder/);
});
