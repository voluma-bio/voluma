/**
 * Lists the live sandboxes the runner created (everything in its Modal app), with run,
 * name and age, and terminates them. A sandbox only outlives its runner after a hard crash
 * (kill -9, machine loss); run this before finishing any work that started sandboxes.
 *
 *   pnpm --filter @voluma/runner sandboxes:clean [--dry-run]
 */
import { parseArgs } from "node:util";
import { ModalClient } from "modal";
import { optional } from "./config.ts";
import { RUNS_APP } from "./modal-sandbox.ts";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } } });
const tokenId = optional("MODAL_TOKEN_ID");
const tokenSecret = optional("MODAL_TOKEN_SECRET");
const client = new ModalClient(tokenId && tokenSecret ? { tokenId, tokenSecret } : undefined);

let count = 0;
try {
  const app = await client.apps.fromName(RUNS_APP);
  for await (const sandbox of client.sandboxes.list({ appId: app.appId })) {
    const tags = await sandbox.getTags();
    const age = tags.startedAt
      ? `${Math.round((Date.now() - Number(tags.startedAt)) / 60000)} min`
      : "unknown age";
    console.log(`${sandbox.sandboxId}  run ${tags.run}  name ${tags.name}  age ${age}`);
    if (!values["dry-run"]) await sandbox.terminate({ wait: true });
    count++;
  }
} catch (error) {
  // The app is created by the first sandbox; before that there is nothing to sweep.
  if (!(error instanceof Error && error.name === "NotFoundError")) throw error;
}
console.log(
  `${count} live sandbox${count === 1 ? "" : "es"}${values["dry-run"] ? "" : " terminated"}`,
);
