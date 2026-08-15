const NEWLINE = 0x0a;

/**
 * Splits a byte stream into `\n`-terminated lines without touching the bytes.
 *
 * Chunks arriving from a pipe are cut at arbitrary offsets, so lines have to be
 * reassembled across them. Everything stays a Buffer on purpose: decoding to a
 * string would mangle invalid UTF-8 and multi-byte characters straddling a
 * chunk boundary, and the relay must hand back exactly what it was given.
 *
 * Emitted lines keep their trailing `\n` (and any `\r` before it), so
 * concatenating every `push()` result plus the final `flush()` reproduces the
 * input byte for byte.
 */
export class LineSplitter {
  #pending: Buffer = Buffer.alloc(0);

  /** Feeds a chunk in and returns the lines it completed, in order. */
  push(chunk: Buffer): Buffer[] {
    this.#pending =
      this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);

    const lines: Buffer[] = [];
    let start = 0;

    for (;;) {
      const index = this.#pending.indexOf(NEWLINE, start);
      if (index === -1) break;
      lines.push(this.#pending.subarray(start, index + 1));
      start = index + 1;
    }

    // Copy the remainder so the emitted slices do not pin the whole chunk.
    this.#pending = Buffer.from(this.#pending.subarray(start));
    return lines;
  }

  /**
   * Returns whatever is left over once the stream ends — a trailing fragment
   * with no final newline. Returns null when the input ended on a boundary, so
   * a newline is never invented.
   */
  flush(): Buffer | null {
    if (this.#pending.length === 0) return null;
    const rest = this.#pending;
    this.#pending = Buffer.alloc(0);
    return rest;
  }
}
