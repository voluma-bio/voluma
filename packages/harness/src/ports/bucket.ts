/**
 * The RunBucket port: the run's bucket, host-side, by key. `ThreadLayout.keyOf` turns the paths
 * the model names into keys. Tools that handle volumes without the sandbox (`read`,
 * `segment_sam`) stream objects through it, because a scan is gigabytes; agent output publishing
 * (`report_output`) copies and removes.
 *
 * `copy` hashes the file where the agent's sandbox has it mounted (`hash`; a file its sandbox
 * does not mount is read through the host, up to `MAX_UNMOUNTED_BYTES`) and copies exactly those
 * bytes to the version's key, server-side, so a file rewritten in between fails the copy. Copying
 * again to the same key (a repeated tool call) is safe.
 *
 * Publishing moves: after the event is stored the caller `remove`s the source and `writeText`s a
 * pointer beside it. Both are safe to repeat, so a call cut off after the event finishes on retry.
 */

/** The largest file an adapter streams through the host itself (no `hash` given). */
export const MAX_UNMOUNTED_BYTES = 64 * 1024 * 1024;

/** The file cannot be published, for a reason the agent can act on; the message is what it reads. */
export class FileRefused extends Error {}

/** `read` and `copy` reject with this when the key does not exist, whatever the store's own error is. */
export class FileNotFound extends Error {}

export interface RunBucket {
  /** Rejects with `FileNotFound` if the key does not exist. */
  read(key: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
  write(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** The names directly under `prefix` (a trailing `/` marks a folder), at most `limit` of them. */
  list(prefix: string, limit: number, signal: AbortSignal): Promise<string[]>;
  /** Rejects with `FileNotFound` if `from` does not exist, `FileRefused` if it is too large to hash without `hash`. Returns the sha256. */
  copy(
    from: string,
    to: string,
    options?: { hash?: () => Promise<string>; signal?: AbortSignal },
  ): Promise<string>;
  /** The text of a small object (up to 1 MiB), or undefined when there is none. */
  readText(key: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  /** Replaces the object with this text. */
  writeText(key: string, text: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** Deletes the object; one that is not there is not an error. */
  remove(key: string): Promise<void>;
}
