/**
 * The Publish port: how a file an agent named becomes part of an output version (agent model).
 * `copy` hashes the file where the agent's sandbox has it mounted (`hash`; a file its sandbox
 * does not mount is read through the host, up to `MAX_UNMOUNTED_BYTES`) and copies exactly those
 * bytes to the version's key, server-side, so a file rewritten in between fails the copy. Copying
 * again to the same key (a repeated tool call) is safe. The errors are `Evidence`'s.
 *
 * Publishing moves: after the event is stored the caller `remove`s the source and `write`s a
 * pointer beside it. Both are safe to repeat, so a call cut off after the event finishes on retry.
 */
export interface Publish {
  /** Rejects with `EvidenceNotFound` if `from` does not exist, `EvidenceRefused` if it is too large to hash without `hash`. Returns the sha256. */
  copy(
    from: string,
    to: string,
    options?: { hash?: () => Promise<string>; signal?: AbortSignal },
  ): Promise<string>;
  /** The text of a small object (up to 1 MiB), or undefined when there is none. */
  read(key: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  /** Replaces the object with this text. */
  write(key: string, text: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** Deletes the object; one that is not there is not an error. */
  remove(key: string): Promise<void>;
}
