/**
 * The History port: what the model sees, one row per message, append-only. Rows
 * are opaque JSON text that the Pi adapter wrote; a resumed thread reads back the
 * same bytes. `idx` is the write-once order and must be the next free one;
 * appending an idx again with the same text is a no-op, with different text an error.
 */
export interface History {
  /** All rows of the thread in idx order. */
  load(threadId: string): Promise<string[]>;
  appendMessage(threadId: string, idx: number, message: string): Promise<void>;
}

/** The idx is taken by different text, or is not the next free one. */
export class HistoryConflict extends Error {}
