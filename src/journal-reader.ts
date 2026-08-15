import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { journalPath, type JournalEntry } from "./journal.js";

/** One physical line of the journal, parsed if it could be. */
export interface JournalLine {
  /** 1-based line number in the file, so a report can point at it. */
  line: number;
  entry: JournalEntry | null;
  /** Why the line could not be used, when `entry` is null. */
  problem: string | null;
}

export class JournalNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`aucun journal à ${path}`);
    this.name = "JournalNotFoundError";
  }
}

/**
 * Resolves what the user meant by a path argument.
 *
 * Nothing at all means the journal this tool records into. A directory means
 * the journal inside it, so `verify ~/.mcp-blackbox` does the obvious thing.
 * Anything else is taken as the file itself.
 */
export function resolveJournalTarget(
  path: string | null,
  location: { env?: NodeJS.ProcessEnv; home?: string } = {},
): string {
  if (path === null) return journalPath(location);

  try {
    if (statSync(path).isDirectory()) return join(path, "journal.jsonl");
  } catch {
    // Not a directory, or not there at all: report it as a file below.
  }
  return path;
}

/**
 * Reads every line of the journal, keeping unparseable ones rather than
 * dropping them — a corrupt line is exactly what `verify` needs to report.
 * Blank lines are skipped: they carry no entry and break nothing.
 */
export function readJournalLines(path: string): JournalLine[] {
  if (!existsSync(path)) throw new JournalNotFoundError(path);

  const contents = readFileSync(path, "utf8");
  const lines: JournalLine[] = [];

  contents.split("\n").forEach((raw, index) => {
    if (raw.trim() === "") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      lines.push({ line: index + 1, entry: null, problem: "JSON invalide" });
      return;
    }

    const problem = describeShape(parsed);
    lines.push({
      line: index + 1,
      entry: problem === null ? (parsed as JournalEntry) : null,
      problem,
    });
  });

  return lines;
}

const REQUIRED: ReadonlyArray<[keyof JournalEntry, string]> = [
  ["seq", "number"],
  ["ts", "string"],
  ["server", "string"],
  ["tool", "string"],
  ["args_hash", "string"],
  ["outcome", "string"],
  ["duration_ms", "number"],
  ["result_hash", "string"],
  ["prev_hash", "string"],
  ["hash", "string"],
];

/** Returns null when the value is a usable entry, or why it is not. */
function describeShape(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "objet JSON attendu";
  }

  const record = value as Record<string, unknown>;
  const missing: string[] = [];
  for (const [field, type] of REQUIRED) {
    if (typeof record[field] !== type) missing.push(String(field));
  }
  if (missing.length > 0) return `champ absent ou invalide : ${missing.join(", ")}`;

  const outcome = record["outcome"];
  if (outcome !== "ok" && outcome !== "error") {
    return `outcome doit valoir "ok" ou "error", trouvé ${JSON.stringify(outcome)}`;
  }

  return null;
}
