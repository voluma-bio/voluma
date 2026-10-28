/**
 * Builds the sandbox image and publishes it under a name, so sandbox start doesn't
 * build one. Run after changing the package list: `pnpm --filter @voluma/runner
 * publish-image <name>`. The name is what `SandboxSpec.image` refers to.
 */
import { ModalClient } from "modal";
import { modalToken } from "./config.ts";

const [name] = process.argv.slice(2);
if (!name) throw new Error("usage: publish-image.ts <name>");

const client = new ModalClient(modalToken());
const app = await client.apps.fromName("voluma-images", { createIfMissing: true });
const image = await client.images
  .fromRegistry("python:3.12-slim")
  .dockerfileCommands([
    "RUN pip install --no-cache-dir numpy==2.5.4 scipy==1.18.1 scikit-image==0.26.0 pydicom==3.0.2 nibabel==5.4.2 SimpleITK==2.5.6",
  ])
  .build(app);
await image.publish(name);
console.log(`published ${name} (${image.imageId})`);
