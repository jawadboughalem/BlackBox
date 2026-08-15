import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JOURNAL_PATTERN, journalDir, type JournalEntry } from "./journal.js";

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
    super(`no journal at ${path}`);
    this.name = "JournalNotFoundError";
  }
}

/**
 * Resolves what the user meant by a path argument, as a list of journals.
 *
 * Nothing at all means every journal in the recording directory; a directory
 * means every journal in it; anything else is taken as a single file. Each
 * proxy session writes its own file, so reading "the journal" means reading
 * all of them.
 *
 * Files come back in name order, which is chronological: the session name
 * starts with a UTC timestamp.
 */
export function resolveJournalTargets(
  path: string | null,
  location: { env?: NodeJS.ProcessEnv; home?: string } = {},
): string[] {
  const directory = path === null ? journalDir(location) : path;

  let isDirectory = false;
  try {
    isDirectory = statSync(directory).isDirectory();
  } catch {
    // Missing, or not a directory: fall through and treat it as a file.
  }

  if (!isDirectory) {
    if (path === null) throw new JournalNotFoundError(directory);
    return [path];
  }

  const found = readdirSync(directory)
    .filter((name) => JOURNAL_PATTERN.test(name))
    .sort()
    .map((name) => join(directory, name));

  if (found.length === 0) throw new JournalNotFoundError(directory);
  return found;
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
      lines.push({ line: index + 1, entry: null, problem: "not valid JSON" });
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
    return "not a JSON object";
  }

  const record = value as Record<string, unknown>;
  const missing: string[] = [];
  for (const [field, type] of REQUIRED) {
    if (typeof record[field] !== type) missing.push(String(field));
  }
  if (missing.length > 0) return `missing or malformed field: ${missing.join(", ")}`;

  const outcome = record["outcome"];
  if (outcome !== "ok" && outcome !== "error") {
    return `outcome must be "ok" or "error", got ${JSON.stringify(outcome)}`;
  }

  return null;
}
