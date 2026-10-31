/** The Files adapter over an object store: reads and writes objects of the run's bucket by key. */
import { FileNotFound, type Files } from "@voluma/harness/ports/files";
import { ObjectNotFound, type ObjectStore } from "@voluma/object-store";

export function storeFiles(store: ObjectStore): Files {
  return {
    async *read(key, signal) {
      const { body } = await store.get(key, { signal }).catch((error) => {
        throw error instanceof ObjectNotFound ? new FileNotFound(key) : error;
      });
      yield* body;
    },
    async write(key, bytes, signal) {
      await store.put(key, bytes, { signal });
    },
    async list(prefix, limit, signal) {
      const { objects, folders } = await store.list(prefix, { folder: true, limit, signal });
      return [...folders, ...objects.map((o) => o.key)]
        .map((k) => k.slice(prefix.length))
        .slice(0, limit);
    },
  };
}
