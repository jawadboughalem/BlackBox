import { basename } from "node:path";
import { GENESIS_HASH } from "./canonical-json.js";
import { computeIndexHash, indexPath, readIndexEntries, type IndexEntry } from "./session-index.js";

/** What a journal turned out to hold, so the index can be checked against it. */
export interface JournalFacts {
  entries: number;
  lastHash: string;
}

export interface IndexBreak {
  /** 1-based position among index lines. */
  index: number;
  line: number;
  seq: number | null;
  reason: string;
}

export interface IndexReport {
  path: string;
  /** Whether the index exists at all. */
  present: boolean;
  ok: boolean;
  sessions: number;
  /** First break in the index's own chain. */
  broken: IndexBreak | null;
  /** Sessions the index records that are no longer on disk. */
  missing: Array<{ file: string; seq: number; entries: number }>;
  /** Journals on disk that the index does not vouch for. */
  unindexed: string[];
  /** Journals whose contents disagree with what the index recorded. */
  mismatched: Array<{ file: string; reason: string }>;
}

/**
 * Checks the index's own chain, then that it agrees with the journals found.
 *
 * The index is what makes a deleted session visible. Removing a journal leaves
 * its index line pointing at a file that is gone; removing the index line
 * instead breaks the index chain. Either way the omission shows up, which is
 * the whole point — nothing local can prevent deletion, but a recorder that
 * cannot notice it is worse than useless.
 */
export function verifyIndex(
  directory: string,
  journalFiles: readonly string[],
  facts: ReadonlyMap<string, JournalFacts>,
): IndexReport {
  const path = indexPath(directory);
  const lines = readIndexEntries(path);
  const onDisk = new Set(journalFiles.map((file) => basename(file)));

  const report: IndexReport = {
    path,
    present: lines.length > 0,
    ok: true,
    sessions: 0,
    broken: null,
    missing: [],
    unindexed: [],
    mismatched: [],
  };

  // No index at all: every journal is unvouched for, but nothing is provably
  // absent either. Reported, not failed — this is what a first run looks like
  // for anyone upgrading from a version that had no index.
  if (!report.present) {
    report.unindexed = [...onDisk].sort();
    return report;
  }

  let previous = GENESIS_HASH;
  const seen = new Set<string>();

  for (const [offset, line] of lines.entries()) {
    const position = offset + 1;

    if (line.entry === null) {
      report.broken = {
        index: position,
        line: line.line,
        seq: null,
        reason: line.problem ?? "unreadable index entry",
      };
      report.ok = false;
      return report;
    }

    const entry = line.entry;
    const fail = (reason: string): IndexReport => {
      report.broken = { index: position, line: line.line, seq: entry.seq, reason };
      report.ok = false;
      return report;
    };

    if (entry.seq !== position) return fail(`expected seq ${position}, found ${entry.seq}`);
    if (entry.prev_hash !== previous) {
      return fail(
        offset === 0
          ? "first index entry must start from the genesis hash"
          : "prev_hash does not match the previous index entry",
      );
    }

    const { hash, ...rest } = entry;
    if (computeIndexHash(rest) !== hash) {
      return fail("recomputed hash does not match: the index entry was modified");
    }

    previous = hash;
    report.sessions += 1;
    seen.add(entry.file);
    checkAgainstDisk(entry, onDisk, facts, report);
  }

  for (const file of [...onDisk].sort()) {
    if (!seen.has(file)) report.unindexed.push(file);
  }

  report.ok = report.missing.length === 0 && report.mismatched.length === 0;
  return report;
}

/** Compares one index line with the journal it claims to describe. */
function checkAgainstDisk(
  entry: IndexEntry,
  onDisk: ReadonlySet<string>,
  facts: ReadonlyMap<string, JournalFacts>,
  report: IndexReport,
): void {
  if (!onDisk.has(entry.file)) {
    report.missing.push({ file: entry.file, seq: entry.seq, entries: entry.entries });
    return;
  }

  const found = [...facts.entries()].find(([path]) => basename(path) === entry.file)?.[1];
  if (found === undefined) return; // the journal failed its own check; that is reported there

  if (found.entries !== entry.entries) {
    report.mismatched.push({
      file: entry.file,
      reason: `holds ${found.entries} entries, the index records ${entry.entries}`,
    });
    return;
  }

  if (found.lastHash !== entry.last_entry_hash) {
    report.mismatched.push({
      file: entry.file,
      reason: "last entry hash does not match the one the index recorded",
    });
  }
}
