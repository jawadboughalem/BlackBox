import { Transform, type TransformCallback } from "node:stream";
import { LineSplitter } from "./line-splitter.js";

/**
 * Pass-through stream that hands each complete `\n`-terminated line to an
 * observer before forwarding it, byte for byte.
 *
 * Being a Transform rather than a pair of `data` handlers keeps backpressure
 * intact: a slow consumer throttles the producer instead of the relay buffering
 * without bound. Observer failures are swallowed — watching the traffic must
 * never be able to break the relay carrying it.
 */
export class LineTap extends Transform {
  readonly #splitter = new LineSplitter();
  readonly #onLine: (line: Buffer) => void;

  constructor(onLine: (line: Buffer) => void) {
    super();
    this.#onLine = onLine;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    for (const line of this.#splitter.push(chunk)) {
      this.#observe(line);
      this.push(line);
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    const rest = this.#splitter.flush();
    if (rest !== null) {
      this.#observe(rest);
      this.push(rest);
    }
    callback();
  }

  #observe(line: Buffer): void {
    try {
      this.#onLine(line);
    } catch {
      // Observation is best effort by design.
    }
  }
}
