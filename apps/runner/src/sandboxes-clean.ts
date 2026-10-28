/**
 * Lists the live sandboxes the runner created (everything in its Modal app), with run,
 * name and age, and terminates them. A sandbox only outlives its runner after a hard crash
 * (kill -9, machine loss); run this before finishing any work that started sandboxes.
 * `--run <id>` limits it to one run (others may be using the rest); `--dry-run` only lists.
 *
 *   pnpm --filter @voluma/runner sandboxes:clean [--run <id>] [--dry-run]
 */
import { parseArgs } from "node:util";
import { ModalClient, NotFoundError } from "modal";
import { modalToken } from "./config.ts";
import { RUNS_APP } from "./modal-sandbox.ts";

const { values } = parseArgs({
  options: { "dry-run": { type: "boolean" }, run: { type: "string" } },
});
const client = new ModalClient(modalToken());

// The app is created by the first sandbox; before that there is nothing to sweep.
const app = await client.apps.fromName(RUNS_APP).catch((error) => {
  if (error instanceof NotFoundError) return undefined;
  throw error;
});
const found = [];
if (app) {
  const tags = values.run ? { run: values.run } : undefined;
  for await (const sandbox of client.sandboxes.list({ appId: app.appId, tags })) {
    found.push({ sandbox, tags: await sandbox.getTags() });
  }
}
for (const { sandbox, tags } of found) {
  const age = tags.startedAt
    ? `${Math.round((Date.now() - Number(tags.startedAt)) / 60000)} min`
    : "unknown age";
  console.log(`${sandbox.sandboxId}  run ${tags.run}  name ${tags.name}  age ${age}`);
}
let failed = 0;
if (!values["dry-run"]) {
  // Request every termination first, then wait: each takes tens of seconds to finish.
  const results = await Promise.allSettled(
    found.map(({ sandbox }) => sandbox.terminate({ wait: true })),
  );
  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      failed++;
      console.error(`could not terminate ${found[i]?.sandbox.sandboxId}: ${result.reason}`);
    }
  }
}
console.log(
  `${found.length} live sandbox${found.length === 1 ? "" : "es"}${values["dry-run"] ? "" : `, ${found.length - failed} terminated`}`,
);
if (failed) process.exitCode = 1;
