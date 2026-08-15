import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JOURNAL_PATTERN, journalDir, type JournalEntry } from "./journal.js";
import { LineSplitter } from "./line-splitter.js";

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

/** Bytes pulled from the journal per read. */
const CHUNK = 64 * 1024;

/**
 * Yields every line of the journal, keeping unparseable ones rather than
 * dropping them — a corrupt line is exactly what `verify` needs to report.
 * Blank lines are skipped: they carry no entry and break nothing.
 *
 * Read in chunks rather than all at once, so memory tracks the longest line
 * instead of the file. Journals are append-only and never truncated, so a
 * long-running setup can accumulate far more than is comfortable to hold.
 * The file descriptor is closed even if the consumer stops early, which
 * `verify` does at the first break.
 */
export function* iterateJournalLines(path: string): Generator<JournalLine> {
  if (!existsSync(path)) throw new JournalNotFoundError(path);

  const fd = openSync(path, "r");
  try {
    const splitter = new LineSplitter();
    const buffer = Buffer.allocUnsafe(CHUNK);
    let lineNumber = 0;

    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (read === 0) break;
      for (const line of splitter.push(Buffer.from(buffer.subarray(0, read)))) {
        lineNumber += 1;
        const parsed = interpretLine(line, lineNumber);
        if (parsed !== null) yield parsed;
      }
    }

    const rest = splitter.flush();
    if (rest !== null) {
      lineNumber += 1;
      const parsed = interpretLine(rest, lineNumber);
      if (parsed !== null) yield parsed;
    }
  } finally {
    closeSync(fd);
  }
}

/** Collects every line into an array. Convenient, but holds the whole file. */
export function readJournalLines(path: string): JournalLine[] {
  return [...iterateJournalLines(path)];
}

/** Turns one raw line into a JournalLine, or null when it is blank. */
function interpretLine(raw: Buffer, lineNumber: number): JournalLine | null {
  const text = raw.toString("utf8");
  if (text.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { line: lineNumber, entry: null, problem: "not valid JSON" };
  }

  const problem = describeShape(parsed);
  return {
    line: lineNumber,
    entry: problem === null ? (parsed as JournalEntry) : null,
    problem,
  };
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
