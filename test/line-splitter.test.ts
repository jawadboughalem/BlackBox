import { describe, expect, it } from "vitest";
import { LineSplitter } from "../src/line-splitter.js";

/** Feeds chunks in and returns everything the splitter emitted, concatenated. */
function roundTrip(chunks: Buffer[]): { lines: Buffer[]; output: Buffer } {
  const splitter = new LineSplitter();
  const lines: Buffer[] = [];
  for (const chunk of chunks) lines.push(...splitter.push(chunk));
  const rest = splitter.flush();
  if (rest) lines.push(rest);
  return { lines, output: Buffer.concat(lines) };
}

describe("LineSplitter", () => {
  it("splits on newlines and keeps the terminator", () => {
    const { lines } = roundTrip([Buffer.from("a\nb\n")]);
    expect(lines.map((l) => l.toString())).toEqual(["a\n", "b\n"]);
  });

  it("reassembles a line split across chunks", () => {
    const { lines } = roundTrip([
      Buffer.from('{"jsonrpc":'),
      Buffer.from('"2.0","id":1}'),
      Buffer.from("\n"),
    ]);
    expect(lines.map((l) => l.toString())).toEqual(['{"jsonrpc":"2.0","id":1}\n']);
  });

  it("emits several lines arriving in one chunk", () => {
    const { lines } = roundTrip([Buffer.from("one\ntwo\nthree\n")]);
    expect(lines).toHaveLength(3);
  });

  it("preserves blank lines", () => {
    const { lines } = roundTrip([Buffer.from("a\n\n\nb\n")]);
    expect(lines.map((l) => l.toString())).toEqual(["a\n", "\n", "\n", "b\n"]);
  });

  it("keeps carriage returns inside the line", () => {
    const { lines } = roundTrip([Buffer.from("a\r\n")]);
    expect(lines.map((l) => l.toString())).toEqual(["a\r\n"]);
  });

  it("never invents a trailing newline", () => {
    const { lines, output } = roundTrip([Buffer.from("no newline here")]);
    expect(lines.map((l) => l.toString())).toEqual(["no newline here"]);
    expect(output.toString()).toBe("no newline here");
  });

  it("emits nothing for an empty input", () => {
    const { lines } = roundTrip([]);
    expect(lines).toEqual([]);
  });

  it("flushes to null when the input ended on a boundary", () => {
    const splitter = new LineSplitter();
    splitter.push(Buffer.from("done\n"));
    expect(splitter.flush()).toBeNull();
  });

  describe("byte transparency", () => {
    const inputs: Array<[string, Buffer]> = [
      ["malformed json", Buffer.from('not json {"half":\n')],
      ["bare text", Buffer.from("hello world\n")],
      ["multi-byte utf-8", Buffer.from("héllo → 日本語\n", "utf8")],
      ["invalid utf-8", Buffer.from([0xff, 0xfe, 0x41, 0x0a])],
      ["embedded nul", Buffer.from([0x61, 0x00, 0x62, 0x0a])],
      ["no terminator", Buffer.from("dangling")],
      ["only newlines", Buffer.from("\n\n\n")],
    ];

    it.each(inputs)("passes %s through unchanged", (_label, input) => {
      const { output } = roundTrip([input]);
      expect(output.equals(input)).toBe(true);
    });

    it("survives a multi-byte character split across chunks", () => {
      const input = Buffer.from("日本語\n", "utf8");
      const chunks = [input.subarray(0, 2), input.subarray(2, 7), input.subarray(7)];
      const { output } = roundTrip(chunks);
      expect(output.equals(input)).toBe(true);
      expect(output.toString()).toBe("日本語\n");
    });

    it("survives input fed one byte at a time", () => {
      const input = Buffer.from('{"a":1}\ngarbage\n\ntail', "utf8");
      const chunks = [...input].map((byte) => Buffer.from([byte]));
      const { output } = roundTrip(chunks);
      expect(output.equals(input)).toBe(true);
    });
  });
});
