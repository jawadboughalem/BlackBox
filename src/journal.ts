import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GENESIS_HASH, canonicalJson, sha256 } from "./canonical-json.js";

/** One completed `tools/call`, as written to the journal. */
export interface JournalEntry {
  seq: number;
  ts: string;
  server: string;
  tool: string;
  args_redacted: unknown;
  args_hash: string;
  outcome: "ok" | "error";
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

/** Resolves the journal file, honouring MCP_BLACKBOX_DIR. */
export function journalPath({ env = process.env, home = homedir() }: JournalLocation = {}): string {
  const override = env.MCP_BLACKBOX_DIR?.trim();
  return join(override && override.length > 0 ? override : join(home, ".mcp-blackbox"), "journal.jsonl");
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
  readonly path: string;

  private constructor(fd: number | null, seq: number, prevHash: string, path: string) {
    this.#fd = fd;
    this.#seq = seq;
    this.#prevHash = prevHash;
    this.path = path;
  }

  /** Opens the journal, continuing an existing chain. Never throws. */
  static open(location: JournalLocation = {}): Journal {
    const path = journalPath(location);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const { seq, prevHash } = readTail(path);
      return new Journal(openSync(path, "a"), seq, prevHash, path);
    } catch {
      return new Journal(null, 1, GENESIS_HASH, path);
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
      this.#prevHash = entry.hash;
      return entry;
    } catch {
      this.#close();
      return null;
    }
  }

  close(): void {
    this.#close();
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

/**
 * Reads the last entry so a new session continues the chain instead of
 * restarting it. Throws when the tail cannot be trusted — the caller turns
 * that into a disabled journal rather than appending an unverifiable link.
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
