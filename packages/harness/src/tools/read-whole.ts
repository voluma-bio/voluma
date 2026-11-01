/**
 * Reads a whole file the model named, for the host-side tools (`read`, `view_image`): by
 * the thread's layout from the run's bucket, or, for a path outside the mounts (the sandbox's
 * /tmp) and a thread that has a sandbox, through that sandbox. A missing file is refused with
 * the files that are in its folder, never with the store's own error.
 */
import type { ThreadLayout } from "../layout";
import { FileNotFound, type Files } from "../ports/files";
import type { Sandbox } from "../ports/sandbox";

const LISTED = 20;
// Hidden folders (`.images/`, `.tool-output/`) sort first in the bucket; list past them.
const FETCHED = 200;

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** The refusal for a missing file, with what its folder holds (hidden names left out). */
function missing(path: string, names: string[]) {
  const dir = path.slice(0, path.lastIndexOf("/") + 1) || "/";
  const visible = names.filter((n) => !n.startsWith("."));
  const shown = visible.slice(0, LISTED).join(", ") + (visible.length > LISTED ? ", ..." : "");
  return `No file at ${path}. ${visible.length > 0 ? `${dir} holds: ${shown}` : `No readable files listed in ${dir}`}`;
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
  if (!layout.mounted(path)) {
    if (deps.sandbox) return readInSandbox(await deps.sandbox(), path, maxBytes, signal);
    try {
      layout.keyOf(path, "read");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : error}. /tmp and the rest of a sandbox's disk are that sandbox's own: ask the worker to copy the file to $SCRATCH.`,
      );
    }
  }
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
    if (error instanceof FileNotFound) {
      const names = await files.list(key.slice(0, key.lastIndexOf("/") + 1), FETCHED, signal);
      const dir = path.slice(0, path.lastIndexOf("/") + 1);
      const readable = names.filter((name) => {
        try {
          layout.keyOf(`${dir}${name.replace(/\/$/, "")}`, "read");
          return true;
        } catch {
          return false;
        }
      });
      throw new Error(missing(path, readable));
    }
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
  // The model's text appears only single-quoted; the messages are built here, from the exit code.
  const command =
    `[ -f ${quote(path)} ] || { ls -- ${quote(dir)} 2>/dev/null | head -n ${LISTED + 1} | head -c 8192; exit 3; }; ` +
    // stat is not a read limit: a file can grow, and /proc files report zero bytes.
    `set -o pipefail; head -c ${maxBytes + 1} -- ${quote(path)} | base64 -w0`;
  let out = "";
  let err = "";
  let code = -1;
  for await (const chunk of sandbox.exec({ command, timeoutSeconds: 120 }, signal)) {
    if (chunk.type === "exit") code = chunk.code;
    else if (chunk.type === "stdout") out += chunk.data;
    else err = (err + chunk.data).slice(0, 8192);
  }
  if (code === 3) throw new Error(missing(path, out.split("\n").filter(Boolean)));
  if (code !== 0) throw new Error(err.trim() || `could not read ${path} (exit ${code})`);
  const bytes = Buffer.from(out, "base64");
  if (bytes.length > maxBytes) throw new Error(`${path} is over ${maxBytes} bytes`);
  return bytes;
}
