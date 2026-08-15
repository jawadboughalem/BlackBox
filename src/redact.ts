/**
 * Keys whose values are replaced wholesale. The journal is meant to be read,
 * shared and diffed, so anything that looks like a credential never lands in
 * it in clear — `args_hash` still covers the untouched arguments, so integrity
 * is preserved without keeping the secret around.
 */
const SECRET_KEY =
  /(^|[-_])(pass(word|wd)?|secret|token|api[-_]?key|apikey|auth(orization)?|credentials?|private[-_]?key|access[-_]?key|session[-_]?id|cookie)([-_]|$)/i;

/** Strings longer than this are cut down; tool arguments can be whole files. */
const MAX_STRING = 256;

/** Arrays longer than this keep a prefix and a count of what was dropped. */
const MAX_ARRAY = 100;

/** Guards against deeply nested or self-referential structures. */
const MAX_DEPTH = 8;

export const REDACTED = "[redacted]";

/**
 * Returns a copy of `value` safe to write to the journal: credential-looking
 * fields replaced, long strings and large arrays trimmed. The shape is kept so
 * the entry stays readable.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated: too deep]";

  if (typeof value === "string") return truncateString(value);

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1));
    if (value.length > MAX_ARRAY) {
      kept.push(`[truncated: ${value.length - MAX_ARRAY} more items]`);
    }
    return kept;
  }

  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      result[key] = SECRET_KEY.test(key) ? REDACTED : redact(source[key], depth + 1);
    }
    return result;
  }

  return value;
}

function truncateString(text: string): string {
  if (text.length <= MAX_STRING) return text;
  return `${text.slice(0, MAX_STRING)}[truncated: ${text.length - MAX_STRING} more chars]`;
}
