import { readFileSync } from "node:fs";

/**
 * Reads the version from the package manifest that ships alongside `dist/`.
 * Falls back to `0.0.0` if the manifest cannot be read (e.g. a partial install).
 */
export function readVersion(): string {
  try {
    const manifest = new URL("../package.json", import.meta.url);
    const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    const version = (pkg as { version?: unknown }).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
