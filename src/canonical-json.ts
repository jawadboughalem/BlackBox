import { createHash } from "node:crypto";

/** Hash recorded as the predecessor of the very first journal entry. */
export const GENESIS_HASH = `sha256:${"0".repeat(64)}`;

/**
 * Serialises a value to JSON with object keys sorted, so the same data always
 * produces the same bytes and therefore the same hash.
 *
 * Keys sort by UTF-16 code unit, the order `Array.prototype.sort` gives.
 * Array order is data and is left alone. Values JSON cannot represent —
 * undefined, functions, NaN — become null, matching `JSON.stringify`, and
 * undefined object properties are dropped the same way it drops them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "bigint":
      return JSON.stringify(value.toString());
    case "object":
      break;
    default:
      // Functions and symbols have no JSON form.
      return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const source = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    fields.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
  }
  return `{${fields.join(",")}}`;
}

/** SHA-256 of a string, prefixed with the algorithm that produced it. */
export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** SHA-256 over the canonical serialisation of a value. */
export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value));
}
