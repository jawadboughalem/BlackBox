import { GENESIS_HASH } from "./canonical-json.js";
import { computeEntryHash } from "./journal.js";
import type { JournalLine } from "./journal-reader.js";
import type { IndexReport, JournalFacts } from "./verify-index.js";

export interface VerifyOk {
  ok: true;
  path: string;
  entries: number;
  /** Hash of the last entry, which the index records independently. */
  lastHash: string;
}

export interface VerifyBroken {
  ok: false;
  path: string;
  /** 1-based position among the journal's entries. */
  index: number;
  /** Line number in the file, which differs once a line is unparseable. */
  line: number;
  /** The entry's own seq, or null when the entry could not be read. */
  seq: number | null;
  reason: string;
  /** Entries checked before the break. */
  verified: number;
}

export type VerifyResult = VerifyOk | VerifyBroken;

/**
 * Recomputes the whole chain and reports the first place it stops holding.
 *
 * Three things have to agree at every step: the sequence number follows its
 * position, `prev_hash` repeats the previous entry's hash, and the entry's own
 * hash matches a fresh computation. Verification stops at the first break —
 * every later entry is unverifiable anyway, since the chain no longer anchors.
 */
export function verifyChain(lines: Iterable<JournalLine>, path: string): VerifyResult {
  let previous = GENESIS_HASH;
  let offset = 0;

  for (const line of lines) {
    const index = offset + 1;

    if (line.entry === null) {
      return {
        ok: false,
        path,
        index,
        line: line.line,
        seq: null,
        reason: line.problem ?? "unreadable entry",
        verified: offset,
      };
    }

    const entry = line.entry;
    const broken = (reason: string): VerifyBroken => ({
      ok: false,
      path,
      index,
      line: line.line,
      seq: entry.seq,
      reason,
      verified: offset,
    });

    if (entry.seq !== index) {
      return broken(`expected seq ${index}, found ${entry.seq}`);
    }

    if (entry.prev_hash !== previous) {
      return broken(
        offset === 0
          ? "first entry must start from the genesis hash"
          : "prev_hash does not match the previous entry",
      );
    }

    const { hash, ...rest } = entry;
    const recomputed = computeEntryHash(rest);
    if (recomputed !== hash) {
      return broken("recomputed hash does not match: the entry was modified");
    }

    previous = hash;
    offset += 1;
  }

  return { ok: true, path, entries: offset, lastHash: previous };
}

/** Outcome of checking every journal the user pointed at. */
export interface JournalsVerified {
  ok: boolean;
  /** Journals checked. Each proxy session writes its own. */
  files: number;
  /** Entries verified across all intact journals. */
  entries: number;
  /** The first break found, or null when every chain holds. */
  broken: VerifyBroken | null;
  /** What each intact journal turned out to hold, for the index to confirm. */
  facts: Map<string, JournalFacts>;
  /** Index cross-check, absent when a single file was named. */
  index: IndexReport | null;
}

/**
 * Verifies several journals. Each carries its own chain from the genesis hash,
 * so they are checked independently; one damaged session does not make the
 * others unverifiable.
 */
export function verifyJournals(
  journals: Iterable<{ path: string; lines: Iterable<JournalLine> }>,
): JournalsVerified {
  let entries = 0;
  let files = 0;
  const facts = new Map<string, JournalFacts>();

  for (const journal of journals) {
    files += 1;
    const result = verifyChain(journal.lines, journal.path);
    if (!result.ok) {
      return {
        ok: false,
        files,
        entries: entries + result.verified,
        broken: result,
        facts,
        index: null,
      };
    }
    entries += result.entries;
    facts.set(result.path, { entries: result.entries, lastHash: result.lastHash });
  }

  return { ok: true, files, entries, broken: null, facts, index: null };
}

/**
 * Adds the index cross-check to a journals-only result.
 *
 * Journal chains alone cannot detect a session that was deleted whole: each
 * file is independent, so the survivors still verify and `verify` would call
 * the record intact. The index is what turns that omission into an error.
 */
export function withIndex(verified: JournalsVerified, report: IndexReport): JournalsVerified {
  return { ...verified, index: report, ok: verified.ok && report.ok };
}

/** Renders the result the way the CLI prints it. */
export function formatVerify(verified: JournalsVerified): string {
  const lines: string[] = [];

  if (verified.broken !== null) {
    const broken = verified.broken;
    const seq = broken.seq === null ? "unreadable" : `seq ${broken.seq}`;
    lines.push(
      `BROKEN at entry ${broken.index} (${seq}) — ${broken.reason}`,
      `  file: ${broken.path}:${broken.line}`,
      `  ${broken.verified} ${plural(broken.verified)} verified before the break`,
    );
    return lines.join("\n");
  }

  const index = verified.index;

  if (index !== null && index.missing.length > 0) {
    lines.push(
      `MISSING — ${index.missing.length} recorded ${
        index.missing.length === 1 ? "session is" : "sessions are"
      } absent from disk`,
    );
    for (const gap of index.missing) {
      lines.push(`  ${gap.file} (${gap.entries} ${plural(gap.entries)}, index seq ${gap.seq})`);
    }
    lines.push(`  index: ${index.path}`);
    return lines.join("\n");
  }

  if (index !== null && index.broken !== null) {
    const seq = index.broken.seq === null ? "unreadable" : `seq ${index.broken.seq}`;
    return [
      `BROKEN index at entry ${index.broken.index} (${seq}) — ${index.broken.reason}`,
      `  file: ${index.path}:${index.broken.line}`,
    ].join("\n");
  }

  if (index !== null && index.mismatched.length > 0) {
    lines.push("MISMATCH — a journal disagrees with what the index recorded");
    for (const bad of index.mismatched) lines.push(`  ${bad.file}: ${bad.reason}`);
    lines.push(`  index: ${index.path}`);
    return lines.join("\n");
  }

  const scope = verified.files === 1 ? "" : ` across ${verified.files} sessions`;
  const chains = verified.files === 1 ? "chain" : "chains";
  lines.push(`OK — ${verified.entries} ${plural(verified.entries)}${scope}, ${chains} intact`);

  // Not a failure: a session killed outright never gets to write its index
  // line. Saying so keeps the reader from assuming the index covers everything.
  if (index !== null && index.unindexed.length > 0) {
    const what = index.present ? "not recorded in the index" : "not covered by any index";
    lines.push(
      "",
      `Note: ${index.unindexed.length} ${
        index.unindexed.length === 1 ? "journal is" : "journals are"
      } ${what}.`,
    );
    for (const file of index.unindexed) lines.push(`  ${file}`);
  }

  return lines.join("\n");
}

function plural(count: number): string {
  return count === 1 ? "entry" : "entries";
}
