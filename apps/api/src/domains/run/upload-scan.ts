/**
 * Uploads a local scan folder as a lab member, through the same API the browser uses
 * (`@voluma/contracts/run`, Uploads), so a prepared scan reaches staging without a browser.
 *   pnpm --filter @voluma/api upload:scan --dir <folder> --name "<scan name>"
 * Reads VOLUMA_URL (the app's origin, e.g. https://volumaapi-staging.up.railway.app),
 * VOLUMA_EMAIL and VOLUMA_PASSWORD (a member's own WorkOS password sign-in) from the
 * environment or the repo .env, and never prints them. Prints the new input's id; the scan
 * then shows in the start screen's picker.
 *
 * Hidden files (a leading `.`, e.g. `.DS_Store`) are skipped. Each PUT is retried a few
 * times; if some still fail, complete names them and the script exits non-zero.
 */
import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { meResponseSchema } from "@voluma/contracts/auth";
import {
  completeUploadConflictSchema,
  createUploadResponseSchema,
  inputSchema,
  type UploadFile,
} from "@voluma/contracts/run";

const { values } = parseArgs({
  options: { dir: { type: "string" }, name: { type: "string" } },
});
if (!values.dir || !values.name) {
  throw new Error('usage: upload:scan --dir <folder> --name "<scan name>"');
}
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const origin = new URL(required("VOLUMA_URL")).origin;
const dir = values.dir;

/** The session cookie, kept current from every response (the API refreshes it). */
const jar = new Map<string, string>();
async function api(path: string, body: unknown): Promise<Response> {
  const res = await fetch(`${origin}/api${path}`, {
    method: "POST",
    // The API's CSRF rules apply to every cookie request, a script's included.
    headers: {
      origin,
      "content-type": "application/json",
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: JSON.stringify(body),
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return res;
}
async function fail(step: string, res: Response): Promise<never> {
  throw new Error(`${step}: ${res.status} ${await res.text()}`);
}

async function listFiles(): Promise<UploadFile[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: UploadFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (path.split("/").some((s) => s.startsWith("."))) continue;
    const size = (await openAsBlob(join(dir, path))).size;
    files.push({ path: path.normalize("NFC"), size });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function put(url: string, path: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: "PUT",
        body: await openAsBlob(join(dir, path)),
      });
      if (res.ok) return true;
      console.error(`${path}: ${res.status} (attempt ${attempt})`);
    } catch (error) {
      console.error(`${path}: ${(error as Error).message} (attempt ${attempt})`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  return false;
}

const files = await listFiles();
if (files.length === 0) throw new Error(`${dir} has no files`);
const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
console.log(`${files.length} files, ${(totalBytes / 1e6).toFixed(1)} MB`);

const signIn = await api("/auth/password", {
  email: required("VOLUMA_EMAIL"),
  password: required("VOLUMA_PASSWORD"),
});
if (!signIn.ok) await fail("sign-in", signIn);
const me = meResponseSchema.parse(await signIn.json());
console.log(`Signed in as ${me.kind === "member" ? me.email : me.kind}`);

const created = await api("/run/inputs", { name: values.name, files });
if (!created.ok) await fail("create", created);
const { inputId, uploads } = createUploadResponseSchema.parse(await created.json());
console.log(`Upload ${inputId}`);

let done = 0;
let sentBytes = 0;
const sizes = new Map(files.map((f) => [f.path, f.size]));
const queue = [...uploads];
const worker = async () => {
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (await put(next.url, next.path)) {
      done++;
      sentBytes += sizes.get(next.path) ?? 0;
      if (done % 25 === 0 || done === uploads.length) {
        console.log(`${done}/${uploads.length} files, ${(sentBytes / 1e6).toFixed(1)} MB`);
      }
    }
  }
};
await Promise.all(Array.from({ length: 8 }, worker));

const completed = await api(`/run/inputs/${inputId}/complete`, {});
if (completed.status === 409) {
  const { missing } = completeUploadConflictSchema.parse(await completed.json());
  throw new Error(`Not stored: ${missing.join(", ")}. Run the script again for a new upload.`);
}
if (!completed.ok) await fail("complete", completed);
const input = inputSchema.parse(await completed.json());
console.log(`Ready: "${input.name}" (${input.id})`);
