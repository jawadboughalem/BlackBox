import { describe, expect, it } from "vitest";
import { sha256 } from "../src/canonical-json.js";
import {
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_SENSITIVE_KEYS,
  REDACTED,
  defaultConfig,
  isLuhnValid,
  isSensitiveKey,
  redact,
  redactString,
} from "../src/redact.js";

const keys = new Set(DEFAULT_SENSITIVE_KEYS);
const scrub = (text: string) => redactString(text);

describe("mechanism 1: sensitive key names", () => {
  it.each([
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apiKey",
    "apikey",
    "x-api-key",
    "authorization",
    "auth",
    "cookie",
    "key",
    "credentials",
    "passphrase",
    "ACCESS TOKEN",
  ])("treats %s as sensitive", (key) => {
    expect(isSensitiveKey(key, keys)).toBe(true);
  });

  it.each(["monkey", "keyboard", "username", "path", "content", "tokenizer", "passage"])(
    "leaves %s alone",
    (key) => {
      expect(isSensitiveKey(key, keys)).toBe(false);
    },
  );

  it("drops the whole value, whatever its type", () => {
    const result = redact({ password: "hunter2", nested: { token: { a: 1 } } }) as Record<
      string,
      unknown
    >;
    expect(result["password"]).toBe(REDACTED);
    expect((result["nested"] as Record<string, unknown>)["token"]).toBe(REDACTED);
  });

  it("keeps non-sensitive siblings intact", () => {
    expect(redact({ user: "jo", password: "hunter2" })).toEqual({
      user: "jo",
      password: REDACTED,
    });
  });

  it("redacts inside arrays of objects", () => {
    expect(redact([{ token: "abc" }, { user: "jo" }])).toEqual([
      { token: REDACTED },
      { user: "jo" },
    ]);
  });
});

describe("mechanism 2: value patterns", () => {
  describe("sk- api keys", () => {
    it("redacts an OpenAI-style key", () => {
      expect(scrub("sk-abcdefghijklmnopqrstuvwxyz0123")).toBe("[redacted:api-key]");
    });

    it("redacts one embedded in a sentence", () => {
      expect(scrub("use sk-abcdefghijklmnopqrstuvwxyz0123 now")).toBe(
        "use [redacted:api-key] now",
      );
    });

    it("leaves a short sk- token alone", () => {
      expect(scrub("sk-abc")).toBe("sk-abc");
    });
  });

  describe("JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

    it("redacts a full token", () => {
      expect(scrub(jwt)).toBe("[redacted:jwt]");
    });

    it("redacts one inside a header value", () => {
      expect(scrub(`Bearer ${jwt}`)).toBe("Bearer [redacted:jwt]");
    });

    it("leaves ordinary dotted text alone", () => {
      expect(scrub("some.dotted.text")).toBe("some.dotted.text");
    });
  });

  describe("emails", () => {
    it.each([
      ["jo@example.com", "[redacted:email]"],
      ["mail me at jo@example.com now", "mail me at [redacted:email] now"],
      ["first.last+tag@sub.example.co.uk", "[redacted:email]"],
    ])("redacts %s", (input, expected) => {
      expect(scrub(input)).toBe(expected);
    });

    it("redacts every occurrence, not just the first", () => {
      expect(scrub("a@b.com and c@d.com")).toBe("[redacted:email] and [redacted:email]");
    });

    it("leaves a bare domain alone", () => {
      expect(scrub("example.com")).toBe("example.com");
    });
  });

  describe("IBANs", () => {
    it("redacts a compact IBAN", () => {
      expect(scrub("FR7630006000011234567890189")).toBe("[redacted:iban]");
    });

    it("redacts a space-grouped IBAN", () => {
      expect(scrub("FR76 3000 6000 0112 3456 7890 189")).toBe("[redacted:iban]");
    });

    it("redacts one inside a sentence", () => {
      expect(scrub("pay to DE89370400440532013000 today")).toBe("pay to [redacted:iban] today");
    });
  });

  describe("card numbers", () => {
    it.each([
      "4242424242424242",
      "4242 4242 4242 4242",
      "4242-4242-4242-4242",
      "5555555555554444",
      "378282246310005",
    ])("redacts %s", (card) => {
      expect(scrub(card)).toBe("[redacted:card]");
    });

    // A bare digit run is not a card number; the checksum is what separates
    // them from ids, sizes and concatenated timestamps.
    it.each(["1234567890123456", "9999999999999999", "1111111111111111"])(
      "leaves %s alone: it fails the Luhn check",
      (digits) => {
        expect(scrub(digits)).toBe(digits);
      },
    );

    it("accepts valid card numbers by checksum", () => {
      expect(isLuhnValid("4242424242424242")).toBe(true);
      expect(isLuhnValid("4242424242424243")).toBe(false);
    });

    it("rejects runs that are too short or too long", () => {
      expect(isLuhnValid("42424242")).toBe(false);
      expect(isLuhnValid("42424242424242424242")).toBe(false);
    });
  });

  it("applies patterns to values under ordinary keys", () => {
    expect(redact({ note: "ping jo@example.com" })).toEqual({
      note: "ping [redacted:email]",
    });
  });

  it("leaves clean text untouched", () => {
    expect(scrub("just a normal sentence, nothing to see")).toBe(
      "just a normal sentence, nothing to see",
    );
  });
});

describe("mechanism 3: truncation", () => {
  const long = "a".repeat(DEFAULT_MAX_STRING_LENGTH + 1);

  it("replaces a string longer than 500 characters", () => {
    expect(scrub(long)).toBe(`<truncated:${sha256(long)}>`);
  });

  it("keeps a string of exactly 500 characters", () => {
    const exact = "b".repeat(DEFAULT_MAX_STRING_LENGTH);
    expect(scrub(exact)).toBe(exact);
  });

  it("hashes the original, so the marker identifies the value", () => {
    const marker = scrub(long);
    expect(marker).toContain(sha256(long));
    expect(marker).not.toContain("aaaa");
  });

  it("gives different markers to different values", () => {
    expect(scrub("x".repeat(600))).not.toBe(scrub("y".repeat(600)));
  });

  // Length is checked before patterns: replacing the whole string means a long
  // value cannot leak through a span the patterns happened not to match.
  it("takes precedence over pattern matching", () => {
    const withEmail = `jo@example.com ${"z".repeat(600)}`;
    expect(scrub(withEmail)).toBe(`<truncated:${sha256(withEmail)}>`);
  });

  it("truncates long strings nested in structures", () => {
    const result = redact({ body: long }) as Record<string, unknown>;
    expect(result["body"]).toBe(`<truncated:${sha256(long)}>`);
  });
});

describe("redact", () => {
  it("passes non-string scalars through", () => {
    expect(redact({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null });
  });

  it("preserves structure", () => {
    expect(redact({ a: [1, { b: "c" }] })).toEqual({ a: [1, { b: "c" }] });
  });

  it("caps very large arrays", () => {
    const result = redact(Array.from({ length: 150 }, (_unused, index) => index)) as unknown[];
    expect(result).toHaveLength(101);
    expect(result.at(-1)).toBe("[truncated: 50 more items]");
  });

  it("stops at a depth limit", () => {
    let nested: unknown = "bottom";
    for (let index = 0; index < 12; index += 1) nested = { nested };
    expect(JSON.stringify(redact(nested))).toContain("too deep");
  });

  it("handles undefined arguments", () => {
    expect(redact(undefined)).toBeUndefined();
  });

  it("respects a custom maximum length", () => {
    const config = { ...defaultConfig(), maxStringLength: 5 };
    expect(redactString("123456", config)).toBe(`<truncated:${sha256("123456")}>`);
    expect(redactString("12345", config)).toBe("12345");
  });
});
