/**
 * A local folder as an `ObjectStore`, with the bucket's keys as paths, for development without R2.
 * A signed URL points at `serve`, which the API mounts at `mount`: the URL carries its method,
 * key, expiry, size and cache header under an HMAC with a per-process secret, so it stops
 * working when the process restarts, as a presigned URL stops working when it expires.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type ObjectInfo, ObjectNotFound, type ObjectStore } from "./index";

const etagOf = (info: { size: number; mtimeMs: number }) => `"${info.size}-${info.mtimeMs}"`;

export type DirectoryStore = ObjectStore & {
  /** Answers the requests that the signed URLs point at (GET and PUT under `mount`). */
  serve(request: Request): Promise<Response>;
};

export function directoryStore(root: string, mount: string): DirectoryStore {
  const base = resolve(root);
  const secret = randomBytes(32);
  const pathOf = (key: string) => {
    const path = resolve(base, key);
    if (!path.startsWith(base + sep)) throw new Error(`${key} is outside the store`);
    return path;
  };
  const statOf = (key: string) =>
    stat(pathOf(key)).then(
      (info) => (info.isFile() ? info : null),
      (error) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      },
    );

  /** Writes whole bytes under a temporary name, then publishes them; `keep` never replaces. */
  async function publish(key: string, write: (path: string) => Promise<void>, keep: boolean) {
    const path = pathOf(key);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await write(temporary);
      if (!keep) {
        await rename(temporary, path);
        return true;
      }
      return await link(temporary, path).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") return false;
          throw error;
        },
      );
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function walk(dir: string, prefix: string, out: string[]) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.endsWith(".tmp")) continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${prefix}${entry.name}/`, out);
      else out.push(prefix + entry.name);
    }
  }

  const sign = (
    method: string,
    key: string,
    expires: number,
    size: number | string,
    cache: string,
  ) =>
    createHmac("sha256", secret)
      .update([method, key, expires, size, cache].join("\n"))
      .digest("hex");
  function signed(method: string, key: string, expiresAt: number, size?: number, cache = "") {
    const expires = Math.floor(expiresAt / 1000);
    const query = new URLSearchParams({
      expires: String(expires),
      ...(size !== undefined && { size: String(size) }),
      ...(cache && { cache }),
      signature: sign(method, key, expires, size ?? "", cache),
    });
    return `${mount}/${key.split("/").map(encodeURIComponent).join("/")}?${query}`;
  }

  const store: DirectoryStore = {
    async head(key) {
      const info = await statOf(key);
      return info && { size: info.size, etag: etagOf(info) };
    },

    async get(key, { ifMatch, signal } = {}) {
      const info = await statOf(key);
      if (!info) throw new ObjectNotFound(key);
      const etag = etagOf(info);
      if (ifMatch && ifMatch !== etag) throw new Error(`${key} changed since it was read`);
      return {
        body: Readable.toWeb(
          createReadStream(pathOf(key), { signal }),
        ) as ReadableStream<Uint8Array>,
        size: info.size,
        etag,
      };
    },

    put: (key, bytes, { ifNoneMatch, signal } = {}) =>
      publish(key, (path) => writeFile(path, bytes, { flag: "wx", signal }), ifNoneMatch === true),

    async presignGet(key, { expiresIn, signingDate = new Date(), cacheControl }) {
      return signed("GET", key, signingDate.getTime() + expiresIn * 1000, undefined, cacheControl);
    },

    async presignPut(key, { size, expiresIn }) {
      return signed("PUT", key, Date.now() + expiresIn * 1000, size);
    },

    async list(prefix, { folder, limit } = {}) {
      // Descend only as far as the prefix's last folder: the rest is a name filter.
      const folderPrefix = prefix.slice(0, prefix.lastIndexOf("/") + 1);
      const keys: string[] = [];
      await walk(pathOf(folderPrefix || "."), folderPrefix, keys);
      // Entries in key order, a folder at its first key, so `limit` cuts as R2 does.
      const entries: { key: string; folder: boolean }[] = [];
      for (const key of keys.filter((k) => k.startsWith(prefix)).sort()) {
        const slash = folder ? key.indexOf("/", prefix.length) : -1;
        const name = slash >= 0 ? key.slice(0, slash + 1) : key;
        if (entries.at(-1)?.key !== name) entries.push({ key: name, folder: slash >= 0 });
      }
      const objects: (ObjectInfo & { key: string })[] = [];
      const folders: string[] = [];
      for (const entry of entries.slice(0, limit)) {
        if (entry.folder) folders.push(entry.key);
        else
          objects.push({
            key: entry.key,
            ...((await store.head(entry.key)) ?? { size: 0, etag: undefined }),
          });
      }
      return { objects, folders };
    },

    async copy(from, to, { ifMatch } = {}) {
      const info = await statOf(from);
      if (!info) throw new ObjectNotFound(from);
      if (ifMatch && ifMatch !== etagOf(info)) throw new Error(`${from} changed since it was read`);
      await publish(
        to,
        (path) => writeFile(path, createReadStream(pathOf(from)), { flag: "wx" }),
        false,
      );
    },

    async delete(keys) {
      await Promise.all(keys.map((key) => rm(pathOf(key), { force: true })));
    },

    async serve(request) {
      const url = new URL(request.url);
      let key: string;
      try {
        key = decodeURIComponent(url.pathname.slice(mount.length + 1));
      } catch {
        return new Response("Bad path", { status: 403 });
      }
      const expires = Number(url.searchParams.get("expires"));
      const size = url.searchParams.get("size") ?? "";
      const cache = url.searchParams.get("cache") ?? "";
      const given = Buffer.from(url.searchParams.get("signature") ?? "", "hex");
      const wanted = Buffer.from(sign(request.method, key, expires, size, cache), "hex");
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted))
        return new Response("Bad signature", { status: 403 });
      if (!(expires * 1000 > Date.now())) return new Response("Expired", { status: 403 });

      if (request.method === "GET") {
        const found = await store.get(key).catch((error) => {
          if (error instanceof ObjectNotFound) return null;
          throw error;
        });
        if (!found) return new Response("Not found", { status: 404 });
        return new Response(found.body, {
          headers: {
            "Content-Length": String(found.size),
            // Stored bytes are untrusted: never let a browser sniff or run them as a page.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            ...(cache && { "Cache-Control": cache }),
          },
        });
      }
      if (request.method === "PUT") {
        if (!request.body || request.headers.get("content-length") !== size)
          return new Response("Wrong length", { status: 403 });
        try {
          await publish(
            key,
            async (path) => {
              let written = 0;
              const body = Readable.fromWeb(
                request.body as import("node:stream/web").ReadableStream,
              );
              body.on("data", (chunk: Buffer) => {
                written += chunk.length;
              });
              await pipeline(body, createWriteStream(path, { flags: "wx" }));
              if (written !== Number(size)) throw new Error("Wrong length");
            },
            false,
          );
        } catch {
          return new Response("Upload failed", { status: 400 });
        }
        return new Response(null, { status: 200 });
      }
      return new Response("Method not allowed", { status: 405 });
    },
  };
  return store;
}
