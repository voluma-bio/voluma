/**
 * Reads a reply as it passes, in bounded memory. An event stream (`byLine`) is split into lines
 * and each goes to `onLine`; any other reply is one text, handed over at the end. Either way at
 * most the last `LINE_CAP` bytes of a line (or of the whole reply) are kept. The text is Latin-1,
 * which loses nothing for the ASCII patterns that are read from it.
 */

/** The most of one line that is kept; a longer line keeps its end, where `"usage":{…}` is. */
export const LINE_CAP = 64 * 1024;

export function replyScanner(byLine: boolean, onLine: (line: string) => void) {
  let partial = "";
  return {
    push(chunk: Uint8Array) {
      const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("latin1");
      const parts = byLine ? text.split("\n") : [text];
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
