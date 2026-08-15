import { sha256 } from "./canonical-json.js";

/** Value written in place of anything matched by a sensitive key name. */
export const REDACTED = "[redacted]";

/** Strings longer than this are replaced by a hash marker. */
export const DEFAULT_MAX_STRING_LENGTH = 500;

/** Arrays longer than this keep a prefix and a count of what was dropped. */
const MAX_ARRAY = 100;

/** Guards against deeply nested or self-referential structures. */
const MAX_DEPTH = 8;

/**
 * Key names whose value is dropped whole. Matching is done per name segment,
 * so `api_key`, `x-api-key` and `apiKey` all hit `key`, while `monkey` does
 * not — segment matching avoids the false positives a substring search gives.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  "auth",
  "authorization",
  "apikey",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "key",
  "pass",
  "passphrase",
  "passwd",
  "password",
  "secret",
  "token",
];

/** A value-level pattern, applied to the inside of every string. */
export interface RedactionPattern {
  /** Appears in the replacement, as `[redacted:name]`. */
  name: string;
  regex: RegExp;
  /** Optional guard that rejects a match the regex alone would over-catch. */
  validate?: (match: string) => boolean;
}

export interface RedactionConfig {
  maxStringLength: number;
  sensitiveKeys: ReadonlySet<string>;
  patterns: readonly RedactionPattern[];
}

/**
 * Patterns matched against string *values*, regardless of their key.
 *
 * Only the matched span is replaced, so surrounding context survives:
 * "mail me at jo@example.com" keeps its shape. Deliberately syntactic — no
 * inference about what a value means, only what it looks like.
 */
export function defaultPatterns(): RedactionPattern[] {
  return [
    {
      name: "jwt",
      regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    },
    {
      name: "api-key",
      regex: /\bsk-[A-Za-z0-9_-]{16,}/g,
    },
    {
      name: "email",
      regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    },
    {
      name: "iban",
      regex: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    },
    {
      // A bare 13-19 digit run matches far more than card numbers — file
      // sizes, ids, concatenated timestamps — so the Luhn checksum decides.
      // That is arithmetic on the digits, not an interpretation of them.
      name: "card",
      regex: /\b(?:\d[ -]?){12,18}\d\b/g,
      validate: isLuhnValid,
    },
  ];
}

export function defaultConfig(): RedactionConfig {
  return {
    maxStringLength: DEFAULT_MAX_STRING_LENGTH,
    sensitiveKeys: new Set(DEFAULT_SENSITIVE_KEYS),
    patterns: defaultPatterns(),
  };
}

/**
 * Returns a copy of `value` safe to write to the journal.
 *
 * Three mechanisms, in order of severity: a value under a sensitive key name
 * is dropped entirely; an over-long string becomes a hash marker; anything
 * else has known-sensitive spans replaced in place. `args_hash` is computed
 * from the untouched arguments elsewhere, so integrity never depends on this.
 */
export function redact(
  value: unknown,
  config: RedactionConfig = defaultConfig(),
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return "[truncated: too deep]";

  if (typeof value === "string") return redactString(value, config);

  if (Array.isArray(value)) {
    const kept: unknown[] = value
      .slice(0, MAX_ARRAY)
      .map((item) => redact(item, config, depth + 1));
    if (value.length > MAX_ARRAY) {
      kept.push(`[truncated: ${value.length - MAX_ARRAY} more items]`);
    }
    return kept;
  }

  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      result[key] = isSensitiveKey(key, config.sensitiveKeys)
        ? REDACTED
        : redact(source[key], config, depth + 1);
    }
    return result;
  }

  return value;
}

/** Applies length and value rules to a single string. */
export function redactString(text: string, config: RedactionConfig = defaultConfig()): string {
  // Length wins over pattern matching: replacing the whole string means an
  // over-long value cannot leak through a span the patterns did not cover.
  if (text.length > config.maxStringLength) {
    return `<truncated:${sha256(text)}>`;
  }

  let result = text;
  for (const pattern of config.patterns) {
    result = result.replace(pattern.regex, (match) =>
      pattern.validate && !pattern.validate(match) ? match : `[redacted:${pattern.name}]`,
    );
  }
  return result;
}

/**
 * Splits a key into name segments and checks each one, so separator style and
 * casing do not matter: `api_key`, `apiKey`, `x-api-key` and `API KEY` all
 * match, `monkey` does not.
 */
export function isSensitiveKey(key: string, sensitive: ReadonlySet<string>): boolean {
  if (sensitive.has(key.toLowerCase())) return true;
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== "");
  return segments.some((part) => sensitive.has(part.toLowerCase()));
}

/** Luhn checksum, the standard validity test for payment card numbers. */
export function isLuhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
