import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { GENESIS_HASH, canonicalJson, sha256 } from "./canonical-json.js";
import { appendIndexEntry } from "./session-index.js";

/** One completed `tools/call`, as written to the journal. */
export interface JournalEntry {
  seq: number;
  ts: string;
  server: string;
  tool: string;
  args_redacted: unknown;
  args_hash: string;
  outcome: "ok" | "error";
  /**
   * Which kind of failure it was. "protocol" is a JSON-RPC error: the call
   * never ran. "tool" is a result carrying isError: the tool ran and refused.
   * For a record of what happened these are different facts, so they are kept
   * apart rather than merged into `outcome`.
   */
  error_kind: "protocol" | "tool" | null;
  error_message: string | null;
  duration_ms: number;
  result_hash: string;
  prev_hash: string;
  hash: string;
}

/** Everything about an entry that is not derived from the chain itself. */
export type EntryInput = Omit<JournalEntry, "seq" | "prev_hash" | "hash">;

export interface JournalLocation {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface OpenOptions {
  /** Record this session in the directory's index when it closes. */
  index?: boolean;
  /** Told why recording is degraded, so nothing is lost quietly. */
  onProblem?: (message: string) => void;
}

/**
 * The journal is private by default: it holds tool arguments, file paths and
 * whatever redaction did not recognise as a secret.
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Directory holding the journals, honouring MCP_BLACKBOX_DIR. */
export function journalDir({ env = process.env, home = homedir() }: JournalLocation = {}): string {
  const override = env.MCP_BLACKBOX_DIR?.trim();
  return override && override.length > 0 ? override : join(home, ".mcp-blackbox");
}

/** Matches the journals this tool writes, including the pre-session layout. */
export const JOURNAL_PATTERN = /^journal(-[^/\\]*)?\.jsonl$/;

/**
 * Name of the file one proxy session writes to.
 *
 * Sessions never share a file. Two proxies writing to one journal would each
 * read the tail at startup, pick the same next sequence number and interleave
 * their writes, producing a chain that fails verification with nobody having
 * tampered with anything — and MCP clients routinely run several servers at
 * once. A file per session removes the shared state instead of guarding it,
 * which needs no cross-process locking to be correct.
 */
export function sessionJournalName(startedAt: Date, pid: number): string {
  const stamp = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `journal-${stamp}-${pid}.jsonl`;
}

/** Resolves the file the current session should write to. */
export function sessionJournalPath(
  location: JournalLocation = {},
  startedAt: Date = new Date(),
  pid: number = process.pid,
): string {
  return join(journalDir(location), sessionJournalName(startedAt, pid));
}

/** Hash of an entry, computed over everything except the hash field itself. */
export function computeEntryHash(entry: Omit<JournalEntry, "hash">): string {
  return sha256(canonicalJson(entry));
}

/**
 * Append-only, hash-chained journal.
 *
 * Recording is strictly secondary to relaying traffic, so no method here ever
 * throws: any failure — unwritable directory, read-only disk, a corrupt tail
 * that would make the chain unverifiable — disables the journal and leaves the
 * proxy running. `enabled` reports whether entries are actually being written.
 */
export class Journal {
  #fd: number | null;
  #seq: number;
  #prevHash: string;
  #written = 0;
  #createdEmpty: boolean;
  #openedAt = new Date().toISOString();
  #options: OpenOptions;
  readonly path: string;

  private constructor(
    fd: number | null,
    seq: number,
    prevHash: string,
    path: string,
    createdEmpty = false,
    options: OpenOptions = {},
  ) {
    this.#fd = fd;
    this.#seq = seq;
    this.#prevHash = prevHash;
    this.path = path;
    this.#createdEmpty = createdEmpty;
    this.#options = options;
  }

  /** Opens this session's own journal file, indexed on close. Never throws. */
  static open(location: JournalLocation = {}, options: OpenOptions = {}): Journal {
    return Journal.openAt(sessionJournalPath(location), { index: true, ...options });
  }

  /**
   * Opens a specific file, continuing its chain if it already holds entries.
   * Used for the session file, and by anything that needs to name the file.
   */
  static openAt(path: string, options: OpenOptions = {}): Journal {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
      tighten(dirname(path), DIR_MODE);

      const fresh = !existsSync(path);
      const { seq, prevHash } = readTail(path);
      const fd = openSync(path, "a", FILE_MODE);
      // An existing file predates this open, so its mode is not ours to assume.
      tighten(path, FILE_MODE);
      return new Journal(fd, seq, prevHash, path, fresh, options);
    } catch (error) {
      // Failing closed on integrity: a tail that cannot be read means the next
      // entry's prev_hash cannot be trusted, so nothing more is written. Saying
      // so matters — losing coverage silently defeats the point of the tool.
      const reason = error instanceof Error ? error.message : String(error);
      options.onProblem?.(`recording disabled for ${path}: ${reason}`);
      return new Journal(null, 1, GENESIS_HASH, path, false, options);
    }
  }

  /** A journal that never writes, for callers that opt out of recording. */
  static disabled(): Journal {
    return new Journal(null, 1, GENESIS_HASH, "");
  }

  get enabled(): boolean {
    return this.#fd !== null;
  }

  /** Sequence number the next entry will receive. */
  get nextSeq(): number {
    return this.#seq;
  }

  /**
   * Appends one entry and flushes it to disk. Returns the entry written, or
   * null when the journal is disabled or the write failed.
   */
  record(input: EntryInput): JournalEntry | null {
    if (this.#fd === null) return null;

    try {
      const unhashed: Omit<JournalEntry, "hash"> = {
        seq: this.#seq,
        ts: input.ts,
        server: input.server,
        tool: input.tool,
        args_redacted: input.args_redacted,
        args_hash: input.args_hash,
        outcome: input.outcome,
        error_kind: input.error_kind,
        error_message: input.error_message,
        duration_ms: input.duration_ms,
        result_hash: input.result_hash,
        prev_hash: this.#prevHash,
      };
      const entry: JournalEntry = { ...unhashed, hash: computeEntryHash(unhashed) };

      writeSync(this.#fd, `${JSON.stringify(entry)}\n`);
      // The journal is an audit trail: an entry that only reached the OS cache
      // is not recorded as far as a crash is concerned.
      try {
        fsyncSync(this.#fd);
      } catch {
        // Not every filesystem supports fsync; the write itself still landed.
      }

      this.#seq += 1;
      this.#written += 1;
      this.#prevHash = entry.hash;
      return entry;
    } catch {
      this.#close();
      return null;
    }
  }

  close(): void {
    const empty = this.#createdEmpty && this.#written === 0;
    const indexed = this.#written > 0 && this.#options.index === true;
    const closedAt = new Date().toISOString();
    this.#close();

    if (indexed) {
      const written = appendIndexEntry(dirname(this.path), {
        file: this.path,
        opened_at: this.#openedAt,
        closed_at: closedAt,
        entries: this.#written,
        last_entry_hash: this.#prevHash,
      });
      if (written === null) {
        this.#options.onProblem?.(
          `could not index ${basename(this.path)}; verify will report it as unindexed`,
        );
      }
    }

    // A server that started and recorded nothing should not leave a file
    // behind: clients restart their servers often, and empty journals would
    // pile up and be counted as sessions by `summary`.
    if (empty) {
      try {
        unlinkSync(this.path);
      } catch {
        // Already gone, or not ours to remove.
      }
    }
  }

  #close(): void {
    if (this.#fd === null) return;
    try {
      closeSync(this.#fd);
    } catch {
      // Nothing useful to do; the journal is being abandoned either way.
    }
    this.#fd = null;
  }
}

/** Best-effort permission fix; Windows and odd filesystems may ignore it. */
function tighten(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Not ours to chmod, or unsupported. The journal is still usable.
  }
}

/**
 * Reads the last entry so an existing file is continued rather than restarted.
 * Throws when the tail cannot be trusted — the caller turns that into a
 * disabled journal rather than appending an unverifiable link.
 */
function readTail(path: string): { seq: number; prevHash: string } {
  if (!existsSync(path)) return { seq: 1, prevHash: GENESIS_HASH };

  const contents = readFileSync(path, "utf8");
  const lines = contents.split("\n").filter((line) => line.trim() !== "");
  const last = lines.at(-1);
  if (last === undefined) return { seq: 1, prevHash: GENESIS_HASH };

  const entry = JSON.parse(last) as Partial<JournalEntry>;
  if (typeof entry.seq !== "number" || typeof entry.hash !== "string") {
    throw new Error("journal tail is not a usable entry");
  }
  return { seq: entry.seq + 1, prevHash: entry.hash };
}
