/**
 * The Files port: host-side access to the run's bucket by key, for tools that handle
 * volumes without the sandbox (`segment_sam`). `ThreadLayout.keyOf` turns the paths the model
 * names into keys. Reads stream because a scan is gigabytes; a write is one object.
 */
export interface Files {
  /** Rejects if the key does not exist. */
  read(key: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
  write(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}
