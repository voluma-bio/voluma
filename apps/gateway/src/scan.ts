/**
 * Reads a reply as it passes, in bounded memory: splits the bytes into lines and hands each to
 * `onLine`, keeping at most the last `LINE_CAP` bytes of a line longer than that. The text is
 * Latin-1, which loses nothing for the ASCII patterns that are read from it.
 */

/** The most of one line that is kept; a longer line keeps its end, where `"usage":{…}` is. */
export const LINE_CAP = 64 * 1024;

export function lineScanner(onLine: (line: string) => void) {
  let partial = "";
  return {
    push(chunk: Uint8Array) {
      const parts = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        .toString("latin1")
        .split("\n");
      partial += parts[0];
      if (partial.length > LINE_CAP) partial = partial.slice(-LINE_CAP);
      for (let i = 1; i < parts.length; i++) {
        onLine(partial);
        partial = parts[i] as string;
        if (partial.length > LINE_CAP) partial = partial.slice(-LINE_CAP);
      }
    },
    end() {
      if (partial) onLine(partial);
      partial = "";
    },
  };
}
