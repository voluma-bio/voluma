/**
 * Reads a whole file the model named, for the host-side tools (`read_file`, `view_image`): by
 * the thread's layout from the run's bucket, or, for a path outside the mounts (the sandbox's
 * /tmp), through the thread's sandbox. A missing file is refused with the files that are in its
 * folder, never with the store's own error.
 */
import type { ThreadLayout } from "../layout";
import { FileNotFound, type Files } from "../ports/files";
import type { Sandbox } from "../ports/sandbox";

const LISTED = 20;

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

async function missing(files: Files, key: string, path: string, signal: AbortSignal) {
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  const names = await files.list(key.slice(0, key.lastIndexOf("/") + 1), LISTED + 1, signal);
  const shown = names.slice(0, LISTED).join(", ") + (names.length > LISTED ? ", ..." : "");
  return `No file at ${path}. ${names.length > 0 ? `${dir} holds: ${shown}` : `${dir} holds no files`}`;
}

/** The file's bytes; throws a message for the model when it is missing, unreadable or over `maxBytes`. */
export async function readWhole(
  deps: { layout: ThreadLayout; files: Files; sandbox?: () => Promise<Sandbox> },
  named: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const { layout, files } = deps;
  const path = layout.resolve(named);
  if (deps.sandbox && !layout.mounted(path))
    return readInSandbox(await deps.sandbox(), path, maxBytes, signal);
  const key = layout.keyOf(path, "read");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of files.read(key, signal)) {
      size += chunk.length;
      if (size > maxBytes) throw new Error(`${path} is over ${maxBytes} bytes`);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof FileNotFound) throw new Error(await missing(files, key, path, signal));
    throw error;
  }
  return Buffer.concat(chunks);
}

/** A file in the sandbox's own disk, which the host cannot read from the bucket: base64 over stdout. */
async function readInSandbox(
  sandbox: Sandbox,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const dir = path.slice(0, path.lastIndexOf("/") + 1) || "/";
  const command =
    `[ -f ${quote(path)} ] || { echo "No file at ${path}. ${dir} holds: $(ls ${quote(dir)} 2>&1 | head -${LISTED} | tr '\\n' ' ')" >&2; exit 3; }; ` +
    `[ "$(stat -c %s ${quote(path)})" -le ${maxBytes} ] || { echo "${path} is over ${maxBytes} bytes" >&2; exit 4; }; ` +
    `base64 -w0 ${quote(path)}`;
  let out = "";
  let err = "";
  let code = -1;
  for await (const chunk of sandbox.exec({ command, timeoutSeconds: 120 }, signal)) {
    if (chunk.type === "exit") code = chunk.code;
    else if (chunk.type === "stdout") out += chunk.data;
    else err += chunk.data;
  }
  if (code !== 0) throw new Error(err.trim() || `could not read ${path} (exit ${code})`);
  return Buffer.from(out, "base64");
}
