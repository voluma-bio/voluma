/**
 * Builds the sandbox image and publishes it under a name, so sandbox start doesn't
 * build one. Run after changing the package list: `pnpm --filter @voluma/runner
 * publish-image <name>`. The name is what `SandboxSpec.image` refers to. The packages are
 * `workflows/microct-analysis/requirements.txt`, the one list; it is installed with
 * `--no-deps` because it pins every transitive package (see its header).
 */
import { readFileSync } from "node:fs";
import { ModalClient } from "modal";
import { modalToken } from "./config.ts";

const [name] = process.argv.slice(2);
if (!name) throw new Error("usage: publish-image.ts <name>");

const requirements = readFileSync(
  new URL("../../../workflows/microct-analysis/requirements.txt", import.meta.url),
);

const client = new ModalClient(modalToken());
const app = await client.apps.fromName("voluma-images", { createIfMissing: true });
const image = await client.images
  .fromRegistry("python:3.12-slim")
  .dockerfileCommands([
    `RUN echo ${requirements.toString("base64")} | base64 -d > /tmp/requirements.txt \\
      && pip install --no-cache-dir --no-deps -r /tmp/requirements.txt && rm /tmp/requirements.txt`,
  ])
  .build(app);
await image.publish(name);
console.log(`published ${name} (${image.imageId})`);
