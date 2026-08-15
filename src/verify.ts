import { GENESIS_HASH } from "./canonical-json.js";
import { computeEntryHash } from "./journal.js";
import type { JournalLine } from "./journal-reader.js";

export interface VerifyOk {
  ok: true;
  path: string;
  entries: number;
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
export function verifyChain(lines: readonly JournalLine[], path: string): VerifyResult {
  let previous = GENESIS_HASH;

  for (const [offset, line] of lines.entries()) {
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
  }

  return { ok: true, path, entries: lines.length };
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
}

/**
 * Verifies several journals. Each carries its own chain from the genesis hash,
 * so they are checked independently; one damaged session does not make the
 * others unverifiable.
 */
export function verifyJournals(
  journals: ReadonlyArray<{ path: string; lines: readonly JournalLine[] }>,
): JournalsVerified {
  let entries = 0;

  for (const journal of journals) {
    const result = verifyChain(journal.lines, journal.path);
    if (!result.ok) {
      return { ok: false, files: journals.length, entries: entries + result.verified, broken: result };
    }
    entries += result.entries;
  }

  return { ok: true, files: journals.length, entries, broken: null };
}

/** Renders the result the way the CLI prints it. */
export function formatVerify(verified: JournalsVerified): string {
  if (verified.ok) {
    const scope =
      verified.files === 1 ? "" : ` across ${verified.files} sessions`;
    const chains = verified.files === 1 ? "chain" : "chains";
    return `OK — ${verified.entries} ${plural(verified.entries)}${scope}, ${chains} intact`;
  }

  const broken = verified.broken!;
  const seq = broken.seq === null ? "unreadable" : `seq ${broken.seq}`;
  return [
    `BROKEN at entry ${broken.index} (${seq}) — ${broken.reason}`,
    `  file: ${broken.path}:${broken.line}`,
    `  ${broken.verified} ${plural(broken.verified)} verified before the break`,
  ].join("\n");
}

function plural(count: number): string {
  return count === 1 ? "entry" : "entries";
}
