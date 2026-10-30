/**
 * The Files port: host-side access to the run's bucket by key, for tools that handle
 * volumes without the sandbox (`segment_sam`). `ThreadLayout.keyOf` turns the paths the model
 * names into keys. Reads stream because a scan is gigabytes; a write is one object.
 */

/** `read` rejects with this when the key does not exist, whatever the store's own error is. */
export class FileNotFound extends Error {}

export interface Files {
  /** Rejects with `FileNotFound` if the key does not exist. */
  read(key: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
  write(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** The names directly under `prefix` (a trailing `/` marks a folder), at most `limit` of them. */
  list(prefix: string, limit: number, signal: AbortSignal): Promise<string[]>;
}
