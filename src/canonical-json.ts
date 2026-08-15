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
  // Walked with an explicit stack rather than recursion. `JSON.parse` accepts
  // structures thousands of levels deep, so a recursive walk would overflow on
  // input the platform itself handled — and a value we cannot hash is a call
  // we cannot record. The output is unchanged either way.
  const out: string[] = [];
  const stack: Frame[] = [{ kind: "value", value }];

  while (stack.length > 0) {
    const frame = stack.pop()!;

    if (frame.kind === "text") {
      out.push(frame.text);
      continue;
    }

    const current = frame.value;
    if (!isContainer(current)) {
      out.push(scalarJson(current));
      continue;
    }

    if (Array.isArray(current)) {
      out.push("[");
      stack.push({ kind: "text", text: "]" });
      // Pushed in reverse so they pop back in order.
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "value", value: current[index] });
        if (index > 0) stack.push({ kind: "text", text: "," });
      }
      continue;
    }

    const source = current as Record<string, unknown>;
    const keys = Object.keys(source)
      .sort()
      .filter((key) => source[key] !== undefined);

    out.push("{");
    stack.push({ kind: "text", text: "}" });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stack.push({ kind: "value", value: source[key] });
      stack.push({ kind: "text", text: `${JSON.stringify(key)}:` });
      if (index > 0) stack.push({ kind: "text", text: "," });
    }
  }

  return out.join("");
}

type Frame = { kind: "value"; value: unknown } | { kind: "text"; text: string };

function isContainer(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

/** Serialises anything that is not an array or object. */
function scalarJson(value: unknown): string {
  if (value === null || value === undefined) return "null";

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "bigint":
      return JSON.stringify(value.toString());
    default:
      // Functions and symbols have no JSON form.
      return "null";
  }
}

/** SHA-256 of a string, prefixed with the algorithm that produced it. */
export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** SHA-256 over the canonical serialisation of a value. */
export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value));
}
