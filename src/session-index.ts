import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { GENESIS_HASH, canonicalJson, sha256 } from "./canonical-json.js";

export const INDEX_FILENAME = "index.jsonl";

/** Lock file guarding the one write each session makes to the index. */
const LOCK_FILENAME = "index.lock";

/** How long to wait for the lock before giving up and leaving the file unindexed. */
const LOCK_TIMEOUT_MS = 5_000;

/** A lock older than this is assumed to belong to a process that died. */
const STALE_LOCK_MS = 30_000;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * One line per journal file, chained the same way entries are.
 *
 * Without it, deleting a whole session would be invisible: each journal is an
 * independent chain, so removing one leaves the others verifying perfectly and
 * `verify` would report that everything is intact. That is the worst failure
 * mode for a recorder — not "the evidence is missing" but "the tool certifies
 * there is nothing to see". The index makes an absent session an error.
 */
export interface IndexEntry {
  seq: number;
  file: string;
  opened_at: string;
  closed_at: string;
  entries: number;
  last_entry_hash: string;
  prev_hash: string;
  hash: string;
}

export type IndexInput = Omit<IndexEntry, "seq" | "prev_hash" | "hash">;

export function indexPath(dir: string): string {
  return join(dir, INDEX_FILENAME);
}

/** Hash of an index line, over everything except the hash field itself. */
export function computeIndexHash(entry: Omit<IndexEntry, "hash">): string {
  return sha256(canonicalJson(entry));
}

/**
 * Appends one line to the index, under a lock.
 *
 * Journals need no locking because sessions never share a file, but the index
 * is shared by construction: its whole purpose is to list every session. The
 * critical section is one short write per session, so a lock is proportionate
 * here in a way it would not be per entry.
 *
 * Returns null if the line could not be written; the caller reports it rather
 * than failing, leaving the journal visible as unindexed.
 */
export function appendIndexEntry(dir: string, input: IndexInput): IndexEntry | null {
  return withLock(dir, () => {
    const path = indexPath(dir);
    const { seq, prevHash } = readIndexTail(path);

    const unhashed: Omit<IndexEntry, "hash"> = {
      seq,
      file: basename(input.file),
      opened_at: input.opened_at,
      closed_at: input.closed_at,
      entries: input.entries,
      last_entry_hash: input.last_entry_hash,
      prev_hash: prevHash,
    };
    const entry: IndexEntry = { ...unhashed, hash: computeIndexHash(unhashed) };

    const fd = openSync(path, "a", FILE_MODE);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
    } finally {
      closeSync(fd);
    }
    return entry;
  });
}

/** Reads the index, keeping unusable lines so they can be reported. */
export function readIndexEntries(path: string): Array<{ line: number; entry: IndexEntry | null; problem: string | null }> {
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .split("\n")
    .map((raw, offset) => ({ raw, line: offset + 1 }))
    .filter(({ raw }) => raw.trim() !== "")
    .map(({ raw, line }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { line, entry: null, problem: "not valid JSON" };
      }
      const problem = describeIndexShape(parsed);
      return { line, entry: problem === null ? (parsed as IndexEntry) : null, problem };
    });
}

function describeIndexShape(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "not a JSON object";
  const record = value as Record<string, unknown>;
  const expected: Array<[string, string]> = [
    ["seq", "number"],
    ["file", "string"],
    ["opened_at", "string"],
    ["closed_at", "string"],
    ["entries", "number"],
    ["last_entry_hash", "string"],
    ["prev_hash", "string"],
    ["hash", "string"],
  ];
  const missing = expected.filter(([field, type]) => typeof record[field] !== type).map(([field]) => field);
  return missing.length === 0 ? null : `missing or malformed field: ${missing.join(", ")}`;
}

function readIndexTail(path: string): { seq: number; prevHash: string } {
  const lines = readIndexEntries(path);
  const last = lines.at(-1);
  if (last === undefined) return { seq: 1, prevHash: GENESIS_HASH };
  if (last.entry === null) throw new Error("index tail is not a usable entry");
  return { seq: last.entry.seq + 1, prevHash: last.entry.hash };
}

/**
 * Runs `action` while holding an exclusive lock on the index directory.
 * Returns null when the lock could not be taken or the action failed.
 */
function withLock<T>(dir: string, action: () => T): T | null {
  const lock = join(dir, LOCK_FILENAME);
  let fd: number | null = null;

  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    for (;;) {
      try {
        // "wx" fails if the file exists, which is what makes this atomic.
        fd = openSync(lock, "wx", FILE_MODE);
        break;
      } catch {
        if (clearIfStale(lock)) continue;
        if (Date.now() >= deadline) return null;
        sleep(20);
      }
    }

    return action();
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
        unlinkSync(lock);
      } catch {
        // The lock will be treated as stale by whoever comes next.
      }
    }
  }
}

/** Removes a lock left behind by a process that never released it. */
function clearIfStale(lock: string): boolean {
  try {
    if (Date.now() - statSync(lock).mtimeMs < STALE_LOCK_MS) return false;
    unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
}

/** Blocks the thread briefly; this code path is synchronous by design. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
