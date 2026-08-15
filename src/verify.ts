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

/** Renders the result the way the CLI prints it. */
export function formatVerify(result: VerifyResult): string {
  if (result.ok) {
    return `OK — ${result.entries} ${plural(result.entries)}, chain intact`;
  }

  const seq = result.seq === null ? "unreadable" : `seq ${result.seq}`;
  return [
    `BROKEN at entry ${result.index} (${seq}) — ${result.reason}`,
    `  file: ${result.path}:${result.line}`,
    `  ${result.verified} ${plural(result.verified)} verified before the break`,
  ].join("\n");
}

function plural(count: number): string {
  return count === 1 ? "entry" : "entries";
}
