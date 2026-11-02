import type { Sandbox } from "../ports/sandbox";
import { Refusal } from "./tools/refusal";

/** The sha256 of a file where the sandbox has it mounted: files are hashed in place, never moved through the host. */
export async function sandboxHash(
  box: Sandbox,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  let out = "";
  let err = "";
  let code = -1;
  const command = `sha256sum < '${path.replaceAll("'", "'\\''")}'`;
  for await (const chunk of box.exec({ command, timeoutSeconds: 900 }, signal)) {
    if (chunk.type === "exit") code = chunk.code;
    else if (chunk.type === "stdout") out += chunk.data;
    else if (chunk.type === "stderr") err += chunk.data;
  }
  // A file the agent named that is not there, or is a folder, is its mistake: the tool's own refusal.
  if (code !== 0) throw new Refusal(`No file at ${path}. Name files in your folder, not folders.`);
  const sha256 = /^[0-9a-f]{64}(?= )/.exec(out)?.[0];
  if (!sha256) {
    throw new Error(`could not hash ${path} (exit ${code}): ${err.trim() || out.trim()}`);
  }
  return sha256;
}
