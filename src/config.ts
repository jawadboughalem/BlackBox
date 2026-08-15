import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { journalPath } from "./journal.js";
import {
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_SENSITIVE_KEYS,
  defaultPatterns,
  type RedactionConfig,
  type RedactionPattern,
} from "./redact.js";

export const CONFIG_FILENAME = ".mcp-blackbox.json";

export interface ConfigLocation {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Shape of the redaction section of `.mcp-blackbox.json`. Every field is
 * optional; anything absent or unusable falls back to the built-in default.
 *
 * `keys` and `patterns` extend the defaults rather than replacing them, so a
 * config can only ever redact more by accident, never less. Switching a
 * built-in off is possible, but has to be spelled out in `disablePatterns`.
 */
export interface RedactionFileConfig {
  maxStringLength?: number;
  keys?: string[];
  patterns?: Array<{ name?: string; regex?: string; flags?: string }>;
  disablePatterns?: string[];
}

export interface FileConfig {
  redaction?: RedactionFileConfig;
}

/** Where the config was found, and what was ignored while reading it. */
export interface LoadedConfig {
  redaction: RedactionConfig;
  path: string | null;
  problems: string[];
}

/**
 * Loads redaction settings, looking in the working directory first and then
 * beside the journal. Never throws: an unreadable or invalid config leaves the
 * defaults in place, with the reasons collected in `problems`.
 */
export function loadConfig(location: ConfigLocation = {}): LoadedConfig {
  const problems: string[] = [];
  const found = findConfigFile(location);

  if (found === null) {
    return { redaction: buildRedaction(undefined, problems), path: null, problems };
  }

  let parsed: FileConfig | undefined;
  try {
    parsed = JSON.parse(readFileSync(found, "utf8")) as FileConfig;
  } catch (error) {
    problems.push(`${found}: not readable as JSON (${describe(error)}); using defaults`);
    return { redaction: buildRedaction(undefined, problems), path: found, problems };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push(`${found}: expected a JSON object; using defaults`);
    return { redaction: buildRedaction(undefined, problems), path: found, problems };
  }

  return { redaction: buildRedaction(parsed.redaction, problems), path: found, problems };
}

/** First existing config file: working directory, then the journal directory. */
export function findConfigFile({
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
}: ConfigLocation = {}): string | null {
  const candidates = [
    join(cwd, CONFIG_FILENAME),
    join(dirname(journalPath({ env, home })), CONFIG_FILENAME),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // An unreadable path is simply not a candidate.
    }
  }
  return null;
}

function buildRedaction(file: RedactionFileConfig | undefined, problems: string[]): RedactionConfig {
  const sensitiveKeys = new Set(DEFAULT_SENSITIVE_KEYS);
  let patterns = defaultPatterns();
  let maxStringLength = DEFAULT_MAX_STRING_LENGTH;

  if (file === undefined) {
    return { maxStringLength, sensitiveKeys, patterns };
  }

  if (file.maxStringLength !== undefined) {
    if (Number.isInteger(file.maxStringLength) && file.maxStringLength > 0) {
      maxStringLength = file.maxStringLength;
    } else {
      problems.push(`redaction.maxStringLength must be a positive integer; kept ${maxStringLength}`);
    }
  }

  if (file.keys !== undefined) {
    if (Array.isArray(file.keys)) {
      for (const key of file.keys) {
        if (typeof key === "string" && key.trim() !== "") sensitiveKeys.add(key.trim().toLowerCase());
        else problems.push("redaction.keys entries must be non-empty strings; entry ignored");
      }
    } else {
      problems.push("redaction.keys must be an array; ignored");
    }
  }

  if (file.disablePatterns !== undefined) {
    if (Array.isArray(file.disablePatterns)) {
      const disabled = new Set(
        file.disablePatterns.filter((name): name is string => typeof name === "string"),
      );
      patterns = patterns.filter((pattern) => !disabled.has(pattern.name));
    } else {
      problems.push("redaction.disablePatterns must be an array; ignored");
    }
  }

  if (file.patterns !== undefined) {
    if (Array.isArray(file.patterns)) {
      for (const entry of file.patterns) {
        const compiled = compilePattern(entry, problems);
        if (compiled !== null) patterns.push(compiled);
      }
    } else {
      problems.push("redaction.patterns must be an array; ignored");
    }
  }

  return { maxStringLength, sensitiveKeys, patterns };
}

/** Compiles one user-supplied pattern, reporting rather than throwing. */
function compilePattern(
  entry: { name?: string; regex?: string; flags?: string } | null,
  problems: string[],
): RedactionPattern | null {
  if (entry === null || typeof entry !== "object") {
    problems.push("redaction.patterns entries must be objects; entry ignored");
    return null;
  }

  const { name, regex, flags } = entry;
  if (typeof name !== "string" || name.trim() === "" || typeof regex !== "string") {
    problems.push("redaction.patterns entries need a name and a regex; entry ignored");
    return null;
  }

  try {
    // Force a global match so every occurrence in a value is replaced, not
    // just the first.
    const requested = typeof flags === "string" ? flags : "";
    const merged = requested.includes("g") ? requested : `${requested}g`;
    return { name: name.trim(), regex: new RegExp(regex, merged) };
  } catch (error) {
    problems.push(`redaction.patterns "${name}" is not a valid regex (${describe(error)}); ignored`);
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
