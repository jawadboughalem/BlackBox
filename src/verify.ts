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
        reason: line.problem ?? "entrée illisible",
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
      return broken(`seq attendu ${index}, trouvé ${entry.seq}`);
    }

    if (entry.prev_hash !== previous) {
      return broken(
        offset === 0
          ? "la première entrée doit partir du hash genesis"
          : "prev_hash ne correspond pas à l'entrée précédente",
      );
    }

    const { hash, ...rest } = entry;
    const recomputed = computeEntryHash(rest);
    if (recomputed !== hash) {
      return broken("hash recalculé différent : l'entrée a été modifiée");
    }

    previous = hash;
  }

  return { ok: true, path, entries: lines.length };
}

/** Renders the result the way the CLI prints it. */
export function formatVerify(result: VerifyResult): string {
  if (result.ok) {
    return `OK — ${result.entries} ${plural(result.entries)}, chaîne intacte`;
  }

  const seq = result.seq === null ? "illisible" : `seq ${result.seq}`;
  return [
    `ROMPUE à l'entrée ${result.index} (${seq}) — ${result.reason}`,
    `  fichier : ${result.path}:${result.line}`,
    `  ${result.verified} ${plural(result.verified)} vérifiée${result.verified === 1 ? "" : "s"} avant la rupture`,
  ].join("\n");
}

function plural(count: number): string {
  return count === 1 ? "entrée" : "entrées";
}
