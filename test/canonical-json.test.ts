import { describe, expect, it } from "vitest";
import { GENESIS_HASH, canonicalJson, hashValue, sha256 } from "../src/canonical-json.js";

describe("canonicalJson", () => {
  it("sorts object keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("produces the same output regardless of insertion order", () => {
    const one = canonicalJson({ z: 1, a: { y: 2, b: 3 } });
    const two = canonicalJson({ a: { b: 3, y: 2 }, z: 1 });
    expect(one).toBe(two);
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ outer: { b: 1, a: 2 } })).toBe('{"outer":{"a":2,"b":1}}');
  });

  it("leaves array order alone", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it.each([
    [null, "null"],
    [undefined, "null"],
    [true, "true"],
    [42, "42"],
    ["hi", '"hi"'],
    [Number.NaN, "null"],
    [Number.POSITIVE_INFINITY, "null"],
  ])("serialises %s", (input, expected) => {
    expect(canonicalJson(input)).toBe(expected);
  });

  it("drops undefined properties, like JSON.stringify", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("escapes strings the same way JSON does", () => {
    expect(canonicalJson('quote " and \n newline')).toBe(JSON.stringify('quote " and \n newline'));
  });

  it("handles an empty object and array", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });
});

describe("hashing", () => {
  it("prefixes the digest with its algorithm", () => {
    expect(sha256("")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("matches the known digest of the empty string", () => {
    expect(sha256("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes equal data to equal digests despite key order", () => {
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
  });

  it("hashes different data to different digests", () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });

  it("uses an all-zero genesis hash", () => {
    expect(GENESIS_HASH).toBe(`sha256:${"0".repeat(64)}`);
  });
});

describe("deeply nested values", () => {
  const nest = (depth: number) => {
    let value: unknown = 1;
    for (let index = 0; index < depth; index += 1) value = { n: value };
    return value;
  };

  // JSON.parse accepts structures thousands of levels deep, so a recursive
  // serialiser would overflow on input the platform itself handled — and a
  // value that cannot be hashed is a call that cannot be recorded.
  it.each([1_000, 10_000, 100_000])("serialises %i levels without overflowing", (depth) => {
    expect(() => canonicalJson(nest(depth))).not.toThrow();
  });

  it("hashes deep values", () => {
    expect(hashValue(nest(50_000))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("serialises a long array without overflowing", () => {
    const wide = Array.from({ length: 200_000 }, (_unused, index) => index);
    expect(canonicalJson(wide)).toBe(JSON.stringify(wide));
  });

  it("still matches JSON.stringify for a nested value", () => {
    expect(canonicalJson(nest(200))).toBe(JSON.stringify(nest(200)));
  });
});
